import type { WebGLRenderer } from 'three'

/** Averages over the frames rendered in the last {@link WINDOW_MS}. */
export interface ScenePassTiming {
  /** The GPU's renderer string, or why it is unknown. */
  gpu: string
  /** Whether GPU times are measured: WebGL 2 with `EXT_disjoint_timer_query_webgl2`. */
  timed: boolean
  /** Frames rendered per second. */
  fps: number
  /** GPU milliseconds per frame in the shadow pass and in the rest of the render. */
  shadowMs: number
  mainMs: number
  /** CPU milliseconds per frame inside `renderer.render`. */
  cpuMs: number
  /** Draw calls and triangles per frame, the shadow pass included, and the shadow pass's own. */
  calls: number
  triangles: number
  shadowCalls: number
  shadowTriangles: number
  pixelRatio: number
}

/** One rendered frame's measures; GPU times arrive a few frames late. */
interface Sample {
  at: number
  shadowMs: number
  mainMs: number
  cpuMs: number
  calls: number
  triangles: number
  shadowCalls: number
  shadowTriangles: number
  /** Timer queries still running for it. */
  open: number
}

const WINDOW_MS = 1000
const PUBLISH_MS = 250

type TimerQueryExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

/**
 * Measures each frame `renderer` draws: GPU time of the shadow pass and of the rest with timer
 * queries, CPU time of the render call, and draw calls and triangles. The render and the shadow
 * map's render are wrapped in place; the returned function unwraps them. Timer queries cannot
 * nest, so the frame is timed as consecutive spans, the shadow pass one of them. `report` is
 * called four times a second.
 */
export function timeScenePasses(
  renderer: WebGLRenderer,
  report: (timing: ScenePassTiming) => void,
): () => void {
  const gl = renderer.getContext()
  const webgl2 =
    typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
  const ext = webgl2
    ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null)
    : null
  const debug = gl.getExtension('WEBGL_debug_renderer_info')
  const gpu = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER))

  const samples: Sample[] = []
  const spans: { query: WebGLQuery; pass: 'shadow' | 'main'; sample: Sample }[] = []
  const spare: WebGLQuery[] = []
  let running: (typeof spans)[number] | undefined
  let current: Sample | undefined

  function span(pass: 'shadow' | 'main' | undefined): void {
    if (!ext || !webgl2) return
    const gl2 = gl as WebGL2RenderingContext
    if (running) {
      gl2.endQuery(ext.TIME_ELAPSED_EXT)
      spans.push(running)
      running = undefined
    }
    if (!pass || !current) return
    const query = spare.pop() ?? gl2.createQuery()
    gl2.beginQuery(ext.TIME_ELAPSED_EXT, query)
    current.open++
    running = { query, pass, sample: current }
  }

  function collect(): void {
    if (!ext) return
    const gl2 = gl as WebGL2RenderingContext
    const disjoint = gl2.getParameter(ext.GPU_DISJOINT_EXT) as boolean
    while (spans.length > 0) {
      const first = spans[0]!
      if (!gl2.getQueryParameter(first.query, gl2.QUERY_RESULT_AVAILABLE)) break
      spans.shift()
      const ns = gl2.getQueryParameter(first.query, gl2.QUERY_RESULT) as number
      // A disjoint GPU (clock change, context switch) makes every pending result meaningless.
      if (!disjoint) first.sample[first.pass === 'shadow' ? 'shadowMs' : 'mainMs'] += ns / 1e6
      first.sample.open--
      spare.push(first.query)
    }
  }

  function publish(now: number): void {
    while (samples.length > 0 && now - samples[0]!.at > WINDOW_MS) samples.shift()
    const done = samples.filter((sample) => sample.open === 0)
    const mean = (key: keyof Sample, from: Sample[] = samples) =>
      from.length ? from.reduce((sum, sample) => sum + sample[key], 0) / from.length : 0
    report({
      gpu,
      timed: !!ext,
      fps: (samples.length * 1000) / WINDOW_MS,
      shadowMs: mean('shadowMs', done),
      mainMs: mean('mainMs', done),
      cpuMs: mean('cpuMs'),
      calls: mean('calls'),
      triangles: mean('triangles'),
      shadowCalls: mean('shadowCalls'),
      shadowTriangles: mean('shadowTriangles'),
      pixelRatio: renderer.getPixelRatio(),
    })
  }

  const shadowMap = renderer.shadowMap
  const render = renderer.render.bind(renderer)
  const renderShadows = shadowMap.render.bind(shadowMap)
  renderer.render = function (scene, camera) {
    collect()
    const started = performance.now()
    current = {
      at: started,
      shadowMs: 0,
      mainMs: 0,
      cpuMs: 0,
      calls: 0,
      triangles: 0,
      shadowCalls: 0,
      shadowTriangles: 0,
      open: 0,
    }
    span('main')
    render(scene, camera)
    span(undefined)
    current.cpuMs = performance.now() - started
    current.calls = renderer.info.render.calls
    current.triangles = renderer.info.render.triangles
    samples.push(current)
    current = undefined
  }
  shadowMap.render = function (...args) {
    const calls = renderer.info.render.calls
    const triangles = renderer.info.render.triangles
    span('shadow')
    renderShadows(...args)
    span('main')
    if (current) {
      current.shadowCalls = renderer.info.render.calls - calls
      current.shadowTriangles = renderer.info.render.triangles - triangles
    }
  }

  // On a timer rather than per frame: a scene that stops rendering still reports that it has.
  const publishing = setInterval(() => {
    collect()
    publish(performance.now())
  }, PUBLISH_MS)

  return () => {
    clearInterval(publishing)
    renderer.render = render
    shadowMap.render = renderShadows
  }
}
