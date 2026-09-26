import type { Group, Mesh, MeshStandardMaterial } from 'three'
import { MeshLambertMaterial } from 'three'
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

let load: Promise<LoadedRoverModel> | undefined

/**
 * The JPL rover model, `public/models/rover/rover.glb`, fetched once per page. Its meshes carry
 * no normals, so they are shaded flat, with Lambert materials over the texture atlas.
 */
export function loadRoverModel(baseURL: string): Promise<LoadedRoverModel> {
  if (!load) {
    const started = parse(`${baseURL.replace(/\/?$/, '/')}models/rover/rover.glb`)
    // A failed load is not cached: a later mount tries again.
    started.catch(() => {
      if (load === started) load = undefined
    })
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
  const lambert = new Map<MeshStandardMaterial, MeshLambertMaterial>()
  let triangles = 0
  gltf.scene.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    const standard = mesh.material as MeshStandardMaterial
    let material = lambert.get(standard)
    if (!material) {
      material = new MeshLambertMaterial({ map: standard.map, flatShading: true })
      lambert.set(standard, material)
      standard.dispose()
    }
    mesh.material = material
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
