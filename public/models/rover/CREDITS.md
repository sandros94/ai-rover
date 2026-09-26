# Rover model credits

`rover.glb` is built by `scripts/rover-model.ts` from NASA/JPL's [m2020-urdf-models](https://github.com/nasa-jpl/m2020-urdf-models) at commit `c422fc6d96f2684521fb64049448d611e670f140` (released 10 June 2022, release IDs URS307049 and URS309682).

**Credit: NASA/JPL-Caltech.** Rover modeling and texturing by Zareh Gorjian; models courtesy of the Mars 2020 Perseverance team, URDF conversion by the JPL RSVP team (from the source repository's README).

## What was changed

- Kept: the chassis, the remote sensing mast and its head with its cameras, the centre differential, both rockers and bogies, the four steering links and the six wheels. Dropped: the robotic arm, turret, drill bits, high-gain antenna and helicopter debris shield.
- Posed: the mast's azimuth and elevation joints are set deployed (head level, facing forward); every other joint is at zero.
- Joined into one binary glTF with one node per URDF joint, re-expressed in the app's body frame (x forward, y left, z up), at full resolution (242,100 triangles; only bitwise-identical vertices welded), the 2k texture atlas re-encoded as WebP, geometry meshopt-compressed with positions quantized to 14 bits per mesh.

## Terms

The source repository has no licence file; its README asks for the credit above. NASA's [Images and Media Usage Guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/) state that NASA content, including texture maps and polygon data of 3D models, is generally not subject to copyright in the United States, that NASA should be acknowledged as the source, and that use must not state or imply NASA's endorsement. This project is not affiliated with or endorsed by NASA or JPL.

The texture atlas carries the rover's "Mars 2020" and "Perseverance" nameplates and the mission mark as they appear on the vehicle; it shows no NASA insignia (the "meatball"), logotype or seal, which the guidelines exclude from free use.
