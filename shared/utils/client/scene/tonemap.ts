import { ShaderChunk } from 'three'
import { ClientError } from '../errors'

export interface AgXLook {
  /** ASC-CDL power in AgX's encoded space: contrast. Blender's "Punchy" look uses 1.35. */
  power: number
  /** ASC-CDL saturation in AgX's encoded space. Blender's "Punchy" look uses 1.4. */
  saturation: number
}

/** The scene's look: Blender's "Punchy". */
export const SCENE_LOOK: Readonly<AgXLook> = Object.freeze({ power: 1.35, saturation: 1.4 })

/** three's placeholder body for `CustomToneMapping`, which {@link installAgXLook} replaces. */
const CUSTOM_HOOK = 'vec3 CustomToneMapping( vec3 color ) { return color; }'

/** The look the shader chunk holds, once installed: three compiles every material from it. */
let installed: Readonly<AgXLook> | undefined

/**
 * three's AgX curve with a look step, as GLSL for the `CustomToneMapping` slot. three ships the
 * base curve with the look left out (`// v = agxLook(v, look);`); this is the same body with an
 * ASC-CDL power and saturation applied after the sigmoid and before the outset matrix, where
 * Blender applies its looks. It runs in every material's fragment shader at the tone mapping
 * stage, one `pow` and one `dot` per fragment over stock AgX: no post-processing pass.
 */
export function agxLookGlsl({ power, saturation }: AgXLook): string {
  if (!(power > 0) || !(saturation >= 0)) {
    throw new ClientError(
      'INVALID_INPUT',
      `agxLookGlsl: power ${power}, saturation ${saturation}; pass a positive power and a non-negative saturation.`,
    )
  }
  return /* glsl */ `
vec3 agxLook( vec3 val ) {
  const vec3 lw = vec3( 0.2126, 0.7152, 0.0722 );
  float luma = dot( val, lw );
  val = pow( max( val, vec3( 0.0 ) ), vec3( ${power.toFixed(4)} ) );
  return luma + ${saturation.toFixed(4)} * ( val - luma );
}

vec3 CustomToneMapping( vec3 color ) {
  const mat3 AgXInsetMatrix = mat3(
    vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
    vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
    vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 )
  );
  const mat3 AgXOutsetMatrix = mat3(
    vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
    vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
    vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 )
  );
  const float AgxMinEv = - 12.47393;
  const float AgxMaxEv = 4.026069;

  color *= toneMappingExposure;
  color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
  color = AgXInsetMatrix * color;
  color = max( color, 1e-10 );
  color = log2( color );
  color = ( color - AgxMinEv ) / ( AgxMaxEv - AgxMinEv );
  color = clamp( color, 0.0, 1.0 );
  color = agxDefaultContrastApprox( color );
  color = agxLook( color );
  color = AgXOutsetMatrix * color;
  color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
  color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
  return clamp( color, 0.0, 1.0 );
}
`
}

/**
 * Fills three's `CustomToneMapping` slot with AgX and `look`, for renderers set to
 * `toneMapping: CustomToneMapping`. The shader chunk is global and read when a material
 * compiles, so this must run before the first one does; a second call with the same look is a
 * no-op, and one with another look is refused, since compiled materials would keep the first.
 */
export function installAgXLook(look: Readonly<AgXLook> = SCENE_LOOK): void {
  if (installed) {
    if (installed.power === look.power && installed.saturation === look.saturation) return
    throw new ClientError(
      'INVALID_INPUT',
      `installAgXLook: the look (power ${installed.power}, saturation ${installed.saturation}) is already installed; install one look per page.`,
    )
  }
  const glsl = agxLookGlsl(look)
  const chunk = ShaderChunk.tonemapping_pars_fragment
  if (!chunk.includes(CUSTOM_HOOK)) {
    throw new ClientError(
      'INVALID_INPUT',
      "installAgXLook: three's CustomToneMapping placeholder is missing; check the three version.",
    )
  }
  ShaderChunk.tonemapping_pars_fragment = chunk.replace(CUSTOM_HOOK, glsl)
  installed = { ...look }
}
