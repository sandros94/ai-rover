# Rover model credits

`rover.<hash>.glb` and `rover-low.<hash>.glb` (each named by its content) are built by `scripts/rover-model.ts` from two NASA/JPL sources:

- NASA's [Mars 2020 Perseverance Rover](https://github.com/nasa/NASA-3D-Resources/tree/master/3D%20Models/Mars%202020%20Perseverance%20Rover) glTF from NASA-3D-Resources at commit `751bf23ccddba9f52bf06f4085e9a1fc59d5e747`: every part drawn, its materials and textures.
- NASA/JPL's [m2020-urdf-models](https://github.com/nasa-jpl/m2020-urdf-models) at commit `c422fc6d96f2684521fb64049448d611e670f140` (released 10 June 2022, release IDs URS307049 and URS309682): the joints the mobility system, the mast and the arm turn about, and the link meshes the suspension is sorted by (not drawn).

**Credit: NASA/JPL-Caltech.** URDF models courtesy of the Mars 2020 Perseverance team, rover modeling and texturing by Zareh Gorjian, URDF conversion by the JPL RSVP team (from the URDF repository's README).

## What was changed

- Posed: NASA's model at rest (the arm stowed as the rover drives), its remote sensing mast at the frame of its deploy animation where the head holds at the top, the mast cable skinned to that frame and baked; its animations, armature and the pivot markers it leaves in the scene removed.
- Fitted onto the URDF by the six wheel centres (0.2 mm rms) and re-expressed in the app's body frame (x forward, y left, z up).
- Cut into one node per URDF joint: the wheels by wheel centre, the suspension's pieces by the URDF link mesh they lie on, the head, mast and the arm's five links by NASA's own hierarchy, the arm posed at rest as the rover reported it stowed (Mars 2020 Navcam PDS label, sol 100). The differential's crank goes with each rocker; each rod gets a node under the differential bar that keeps it pointing at its crank.
- Materials baked: each moving part's materials into atlas pages shared by the parts cut from the same meshes, NASA's texels copied unscaled and the plain materials as palette colours, normal scales baked into the normal maps; the specular and IOR settings of three opaque materials dropped. The transmissive glass (camera lenses, name-plate cover) drawn blended at 30 % opacity, as one palette material per part. Each part's triangles joined per page. Geometry meshopt-compressed with positions quantized to 14 bits per mesh; pages stored as WebP (colour lossy, normals near-lossless).
- `rover-low.<hash>.glb`, the low-poly model, drawn as the rover's stand-in while the full model loads and far from the camera, and as the silhouette for the places a rover was lost: the same nodes and pose, each wheel a fitted prism and every other part's meshes simplified with meshoptimizer or boxed, then fitted to the full model's silhouette (1,987 triangles in all), with no texture.

## Terms

The URDF repository has no licence file; its README asks for the credit above. NASA-3D-Resources describes its assets as free to use without copyright, pointing to NASA's [Images and Media Usage Guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/), which state that NASA content, including texture maps and polygon data of 3D models, is generally not subject to copyright in the United States, that NASA should be acknowledged as the source, and that use must not state or imply NASA's endorsement. This project is not affiliated with or endorsed by NASA or JPL.

NASA's textures carry the markings painted on the vehicle: the "Mars 2020" and "Perseverance" nameplates and the NASA insignia (the "meatball") on the body. The guidelines exclude the insignia from free use; it appears here only as part of the vehicle's likeness in NASA's own model.
