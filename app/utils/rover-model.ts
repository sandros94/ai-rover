import type { Group, Material, Mesh, MeshStandardMaterial, Object3D, Texture } from 'three'
import { ShaderChunk } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'

export interface LoadedRoverModel {
  /** The model's scene, shared: place a `clone()` of it. */
  scene: Group
  triangles: number
  /** Size of the downloaded file, bytes. */
  bytes: number
  /** Fetch, decode and parse time of the first load, milliseconds. */
  loadMs: number
}

/**
 * Which build of the rover: `full`, the rover itself at full resolution with its materials and
 * textures; `ghost`, the untextured low-poly silhouette the death markers draw.
 */
export type RoverModelFile = 'full' | 'ghost'

const FILES: Record<RoverModelFile, string> = {
  full: 'models/rover/rover.glb',
  ghost: 'models/rover/rover-ghost.glb',
}

const loads = new Map<RoverModelFile, Promise<LoadedRoverModel>>()

/**
 * A rover model under `public/models/rover/`, fetched once per page, drawn with the materials it
 * carries (three's standard and physical materials: metals, glass, normal maps), which reflect
 * the scene's environment.
 */
export function loadRoverModel(
  baseURL: string,
  file: RoverModelFile = 'full',
): Promise<LoadedRoverModel> {
  let load = loads.get(file)
  if (!load) {
    const started = parse(`${baseURL.replace(/\/?$/, '/')}${FILES[file]}`)
    // A failed load is not cached: a later mount tries again.
    started.catch(() => {
      if (loads.get(file) === started) loads.delete(file)
    })
    loads.set(file, started)
    load = started
  }
  return load
}

async function parse(url: string): Promise<LoadedRoverModel> {
  const started = performance.now()
  const response = await fetch(url)
  if (!response.ok) throw new Error(`loadRoverModel: GET ${url} answered ${response.status}.`)
  const data = await response.arrayBuffer()
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(data, '')
  let triangles = 0
  gltf.scene.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    for (const material of [mesh.material].flat()) reflectOnly(material)
    const index = mesh.geometry.index
    triangles += (index ? index.count : mesh.geometry.attributes.position!.count) / 3
  })
  return {
    scene: gltf.scene,
    triangles,
    bytes: data.byteLength,
    loadMs: performance.now() - started,
  }
}

/**
 * The scene's environment turned into three's frame: its equirectangular maps are y up, the
 * scene is z up. `SceneEnvironment` paints its sky for this rotation.
 */
export const ENVIRONMENT_ROTATION = { x: -Math.PI / 2, y: 0, z: 0 } as const

/** Lends `environment` to every standard material of `object`, or takes it back with `null`. */
export function applyEnvironment(object: Object3D, environment: Texture | null): void {
  object.traverse((child) => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    for (const material of [mesh.material].flat() as MeshStandardMaterial[]) {
      if (!material.isMeshStandardMaterial || material.envMap === environment) continue
      material.envMap = environment
      const { x, y, z } = ENVIRONMENT_ROTATION
      material.envMapRotation.set(x, y, z)
      material.needsUpdate = true
    }
  })
}

/**
 * The environment adds reflections only. The scene's hemisphere light is the sky's diffuse light
 * on every surface, the terrain's Lambert included; the environment's own diffuse term would
 * light the rover's matte paint a second time with the same sky.
 */
function reflectOnly(material: Material): void {
  if (!(material as MeshStandardMaterial).isMeshStandardMaterial) return
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_maps>',
      ShaderChunk.lights_fragment_maps.replace(
        'iblIrradiance += getIBLIrradiance( geometryNormal );',
        '',
      ),
    )
  }
  material.customProgramCacheKey = () => 'reflect-only'
}
