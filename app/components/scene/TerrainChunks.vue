<script setup lang="ts">
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshDepthMaterial,
  MeshLambertMaterial,
  Vector2,
} from 'three'
import type { WebGLProgramParametersWithUniforms } from 'three'
import type { GridRect } from '#shared/utils/client'
import { maskChange } from '#shared/utils/client'
import type { ChunkFog, ChunkMesh, LodLevel, TerrainChunk } from '#shared/utils/client/scene'
import {
  chunkCastsShadow,
  chunkDistance,
  chunkFogged,
  chunkLevel,
  chunkMesh,
  chunkRect,
  DEFAULT_SKIRT_M,
  FOG_STEP,
  LOD_STEPS,
  recolourChunkMesh,
  refogChunkMesh,
} from '#shared/utils/client/scene'

const props = defineProps<{
  /**
   * The chunks to draw. A new array adds the entries not drawn yet and drops those gone; an entry
   * kept as the same object keeps its mesh, one replaced is drawn again.
   */
  chunks: { chunk: TerrainChunk }[]
  /** Height mapped to the ends of the colour ramp, fixed for the scene so colours do not shift. */
  heightRange: { min: number; max: number }
  /** Where full resolution is kept: the rover. */
  focus: { x: number; y: number }
  /** World height at a point, for shading chunk edges from their neighbours. */
  heightAt?: (x: number, y: number) => number | undefined
  /**
   * The stop disk's fog, drawn in the scene's fog colour. A new value with `rects` redraws only
   * the chunks meeting those rectangles of the disk grid; without `rects`, every chunk.
   */
  fog?: ChunkFog & { rects?: GridRect[] }
  /**
   * One byte per disk vertex, laid out as the fog, 1 where the rover has the ground in sight
   * now; revealed ground out of it, or all of it while there is none, takes the seen-before tint.
   * A new value recolours, in place, only the chunks meeting what changed.
   */
  sight?: Uint8Array
  /** The stop's survey, world metres: ground beyond it is not drawn. Absent: none is cut. */
  survey?: { center: { x: number; y: number }; radius: number }
  /**
   * Ground within `rangeM` of the point casts shadows, farther ground only receives; without
   * casters no ground casts. Re-evaluated as the point moves, like the levels.
   */
  casters?: { x: number; y: number; rangeM: number } | null
}>()

/** Distance the focus must move before levels are re-evaluated. */
const REFRESH_M = 8
/** Vertex stride per drawn level: the two distance levels, then the one for chunks all fog. */
const STEPS = [...LOD_STEPS, FOG_STEP] as const
const FOG_LEVEL = 2
type Level = LodLevel | typeof FOG_LEVEL

interface Drawn {
  source: { chunk: TerrainChunk }
  level: Level
  mesh: Mesh
  /** Geometry per level with the arrays it holds, built on first use. */
  built: ({ geometry: BufferGeometry; arrays: ChunkMesh } | undefined)[]
  /** Whether the fog covers the whole chunk, as of the fog last applied. */
  fogged: boolean
  /** The fog its built levels show. */
  fog: ChunkFog | undefined
}

const root = new Group()
/**
 * The survey cut per fragment, so its edge is a true circle at every level of detail; the
 * uniforms are shared with the compiled programs and follow the prop. The shadow pass cuts too:
 * ground beyond the survey is not shown, so it casts no shadow into it either.
 */
const surveyUniforms = {
  surveyCenter: { value: new Vector2() },
  // Far beyond any disk: nothing is cut until a survey is given.
  surveyRadius: { value: 1e9 },
}
function cutToSurvey(shader: WebGLProgramParametersWithUniforms): void {
  Object.assign(shader.uniforms, surveyUniforms)
  shader.vertexShader = `varying vec2 vSurveyXY;\n${shader.vertexShader.replace(
    '#include <project_vertex>',
    '#include <project_vertex>\n\tvSurveyXY = (modelMatrix * vec4(transformed, 1.0)).xy;',
  )}`
  shader.fragmentShader = `uniform vec2 surveyCenter;\nuniform float surveyRadius;\nvarying vec2 vSurveyXY;\n${shader.fragmentShader.replace(
    'void main() {',
    'void main() {\n\tif (distance(vSurveyXY, surveyCenter) > surveyRadius) discard;',
  )}`
}
watchEffect(() => {
  const survey = props.survey
  surveyUniforms.surveyCenter.value.set(survey?.center.x ?? 0, survey?.center.y ?? 0)
  surveyUniforms.surveyRadius.value = survey?.radius ?? 1e9
})
const material = new MeshLambertMaterial({ vertexColors: true })
material.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nattribute float fogAmount;\nvarying float vFogAmount;',
    )
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFogAmount = fogAmount;')
  // three applies fog after tone mapping and in the output colour space, as it clears to the
  // background: fogged ground mixed to the fog colour here is the sky's colour exactly, at any
  // exposure. The scene always has fog, so the mix is never left out.
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vFogAmount;')
    .replace(
      '#include <fog_fragment>',
      '#include <fog_fragment>\n#ifdef USE_FOG\ngl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, vFogAmount );\n#endif',
    )
  cutToSurvey(shader)
}
/**
 * The shadow pass draws the ground without its skirts. A skirt's top edge lies on the ground,
 * and where a coarse chunk meets a fine one it stands a few centimetres proud of it: a low sun
 * would draw every chunk seam as a line of shadow. Skirt fragments, and only theirs, have a
 * `skirt` above 0.
 */
const depthMaterial = new MeshDepthMaterial()
depthMaterial.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nattribute float skirt;\nvarying float vSkirt;',
    )
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkirt = skirt;')
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vSkirt;')
    .replace('void main() {', 'void main() {\n  if ( vSkirt > 0.0 ) discard;')
  cutToSurvey(shader)
}
const drawn = new Map<string, Drawn>()
let lastFocus: { x: number; y: number } | undefined
let lastCasters: { x: number; y: number; rangeM: number } | null | undefined

const keyOf = (chunk: TerrainChunk) => `${chunk.cx},${chunk.cy}`

/** The sight when it fits the fog's disk; one that does not is no sight. */
function fitSight(sight: Uint8Array | undefined): Uint8Array | undefined {
  return sight && sight.length === props.fog?.surface.amount.length ? sight : undefined
}

function meshOptions(chunk: TerrainChunk, level: Level) {
  const heightAt = props.heightAt
  const cells = chunk.vertexCount - 1
  const fog = props.fog
  const sight = fitSight(props.sight)
  return {
    heightRange: props.heightRange,
    step: level === FOG_LEVEL && cells % FOG_STEP !== 0 ? cells : STEPS[level],
    skirtM: DEFAULT_SKIRT_M,
    fog: fog && sight ? { ...fog, sight } : fog,
    heightOutside:
      heightAt && ((i: number, j: number) => heightAt(i * chunk.cellSize, j * chunk.cellSize)),
  }
}

function build(entry: Drawn, level: Level): NonNullable<Drawn['built'][number]> {
  const chunk = entry.source.chunk
  const arrays = chunkMesh(chunk, meshOptions(chunk, level))
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(arrays.positions, 3))
  geometry.setAttribute('color', new BufferAttribute(arrays.colors, 3))
  geometry.setAttribute('normal', new BufferAttribute(arrays.normals, 3))
  geometry.setAttribute('fogAmount', new BufferAttribute(arrays.fogAmounts, 1))
  const skirt = new Uint8Array(arrays.fogAmounts.length).fill(1, arrays.side * arrays.side)
  geometry.setAttribute('skirt', new BufferAttribute(skirt, 1))
  geometry.setIndex(new BufferAttribute(arrays.indices, 1))
  geometry.computeBoundingSphere()
  return { geometry, arrays }
}

function show(entry: Drawn, level: Level): void {
  entry.level = level
  entry.built[level] ??= build(entry, level)
  entry.mesh.geometry = entry.built[level]!.geometry
}

function drop(entry: Drawn): void {
  for (const built of entry.built) built?.geometry.dispose()
  entry.built = []
}

/** The level a chunk should show: the fog level when fog covers all of it, else by distance. */
function levelOf(entry: Pick<Drawn, 'source' | 'fogged'>, current?: Level): Level {
  if (entry.fogged) return FOG_LEVEL
  const held = current === FOG_LEVEL ? undefined : current
  return chunkLevel(chunkDistance(entry.source.chunk, props.focus), held)
}

const isFogged = (chunk: TerrainChunk) => !!props.fog && chunkFogged(chunk, props.fog)

const meets = (a: GridRect, b: GridRect) => a.i0 < b.i1 && b.i0 < a.i1 && a.j0 < b.j1 && b.j0 < a.j1

/** Rewrites heights and colours on the levels built so far of the chunks the fog change meets. */
function applyFog(): void {
  const fog = props.fog
  const rects = fog?.rects
  for (const entry of drawn.values()) {
    // Built since this fog came in: it shows it already.
    if (entry.fog === fog) continue
    if (!fog || !rects) {
      drop(entry)
      entry.fogged = isFogged(entry.source.chunk)
      show(entry, levelOf(entry, entry.level))
      entry.fog = fog
      continue
    }
    const chunk = entry.source.chunk
    const area = chunkRect(chunk, fog.layout)
    if (!rects.some((rect) => meets(area, rect))) continue
    repaint(entry)
  }
}

/**
 * Rewrites heights, colours, normals and fog amounts of the levels built so far to the current
 * fog and neighbours, keeping their geometry, and moves to the fog level or back as the fog now
 * asks.
 */
function repaint(entry: Drawn): void {
  const chunk = entry.source.chunk
  entry.fog = props.fog
  entry.built.forEach((built, level) => {
    if (!built) return
    refogChunkMesh(built.arrays, chunk, meshOptions(chunk, level as Level))
    for (const name of ['position', 'color', 'normal', 'fogAmount'])
      built.geometry.getAttribute(name).needsUpdate = true
    built.geometry.computeBoundingSphere()
  })
  entry.fogged = isFogged(chunk)
  const level = levelOf(entry, entry.level)
  if (level !== entry.level) show(entry, level)
}

/** Rewrites only the colours of the built levels of chunks whose ground entered or left sight. */
function applySight(next: Uint8Array | undefined, previous: Uint8Array | undefined): void {
  const fog = props.fog
  if (!fog) return
  const none = new Uint8Array(fog.surface.amount.length)
  const changed = maskChange(fitSight(previous) ?? none, fitSight(next) ?? none, fog.layout.width)
  if (!changed) return
  for (const entry of drawn.values()) {
    const chunk = entry.source.chunk
    if (entry.fogged || !meets(chunkRect(chunk, fog.layout), changed)) continue
    entry.built.forEach((built, level) => {
      if (!built) return
      recolourChunkMesh(built.arrays, chunk, meshOptions(chunk, level as Level))
      built.geometry.getAttribute('color').needsUpdate = true
    })
  }
}

function sync(): void {
  const wanted = new Map(props.chunks.map((source) => [keyOf(source.chunk), source]))
  const arrived: TerrainChunk[] = []
  for (const [key, entry] of drawn) {
    if (wanted.has(key)) continue
    drop(entry)
    root.remove(entry.mesh)
    drawn.delete(key)
  }
  for (const [key, source] of wanted) {
    let entry = drawn.get(key)
    if (!entry) {
      const mesh = new Mesh(undefined, material)
      mesh.castShadow = chunkCastsShadow(source.chunk, props.casters ?? null)
      mesh.customDepthMaterial = depthMaterial
      mesh.receiveShadow = true
      const { cx, cy, vertexCount, cellSize } = source.chunk
      const size = (vertexCount - 1) * cellSize
      mesh.position.set(cx * size, cy * size, 0)
      mesh.updateMatrix()
      mesh.matrixAutoUpdate = false
      root.add(mesh)
      entry = {
        source,
        level: 0,
        mesh,
        built: [],
        fogged: isFogged(source.chunk),
        fog: undefined,
      }
      drawn.set(key, entry)
      arrived.push(source.chunk)
      show(entry, levelOf(entry))
      entry.fog = props.fog
      continue
    }
    if (entry.source !== source) {
      drop(entry)
      entry.source = source
      entry.fogged = isFogged(source.chunk)
      show(entry, levelOf(entry, entry.level))
      entry.fog = props.fog
      continue
    }
    const level = levelOf(entry, entry.level)
    if (level !== entry.level) show(entry, level)
  }
  // A chunk's edge colours read its neighbours' heights: redraw those next to new arrivals.
  if (props.heightAt) {
    for (const chunk of arrived) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const neighbour = drawn.get(`${chunk.cx + dx},${chunk.cy + dy}`)
          if (!neighbour || (dx === 0 && dy === 0) || arrived.includes(neighbour.source.chunk))
            continue
          repaint(neighbour)
        }
      }
    }
  }
  lastFocus = { ...props.focus }
}

/** Which chunks cast shadows, from the casters as they are now. */
function applyCasters(): void {
  const casters = props.casters ?? null
  for (const entry of drawn.values())
    entry.mesh.castShadow = chunkCastsShadow(entry.source.chunk, casters)
  lastCasters = casters && { ...casters }
}

watch(() => props.chunks, sync, { immediate: true })
watch(
  () => props.casters,
  (casters) => {
    const last = lastCasters
    const moved =
      !casters ||
      !last ||
      casters.rangeM !== last.rangeM ||
      Math.hypot(casters.x - last.x, casters.y - last.y) >= REFRESH_M
    if (moved) applyCasters()
  },
  { immediate: true },
)
watch(() => props.fog, applyFog)
watch(() => props.sight, applySight)
watch(
  () => props.heightRange,
  () => {
    for (const entry of drawn.values()) {
      drop(entry)
      show(entry, entry.level)
    }
  },
)
watch(
  () => props.focus,
  (focus) => {
    if (!lastFocus || Math.hypot(focus.x - lastFocus.x, focus.y - lastFocus.y) >= REFRESH_M) sync()
  },
)

onBeforeUnmount(() => {
  for (const entry of drawn.values()) drop(entry)
  drawn.clear()
  material.dispose()
  depthMaterial.dispose()
})
</script>

<template>
  <primitive :object="root" />
</template>
