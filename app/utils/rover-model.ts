import type { Group, Mesh, MeshStandardMaterial } from 'three'
import { MeshLambertMaterial } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'

export interface LoadedRoverModel {
  /** The model's scene, shared: place a `clone()` of it. */
  scene: Group
  triangles: number
  /** Fetch, decode and parse time of the first load, milliseconds. */
  loadMs: number
}

const FILES = { hero: 'rover.glb', low: 'rover-low.glb' } as const

const loads = new Map<string, Promise<LoadedRoverModel>>()

/**
 * The JPL rover model from `public/models/rover/`, fetched once per page per variant. Its meshes
 * carry no normals, so they are shaded flat, with Lambert materials over the texture atlas.
 */
export function loadRoverModel(
  variant: keyof typeof FILES,
  baseURL: string,
): Promise<LoadedRoverModel> {
  const url = `${baseURL.replace(/\/?$/, '/')}models/rover/${FILES[variant]}`
  let load = loads.get(url)
  if (!load) {
    load = parse(url)
    // A failed load is not cached: a later mount tries again.
    load.catch(() => loads.delete(url))
    loads.set(url, load)
  }
  return load
}

async function parse(url: string): Promise<LoadedRoverModel> {
  const started = performance.now()
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url)
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
  return { scene: gltf.scene, triangles, loadMs: performance.now() - started }
}
