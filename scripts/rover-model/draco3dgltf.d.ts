declare module 'draco3dgltf' {
  /** The glTF build of Google's Draco codec, as `@gltf-transform/extensions` takes it. */
  const draco3d: {
    createDecoderModule(): Promise<unknown>
    createEncoderModule(): Promise<unknown>
  }
  export default draco3d
}
