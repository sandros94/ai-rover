import { ShaderChunk } from 'three'
import { describe, expect, it } from 'vitest'
import { agxLookGlsl, installAgXLook, SCENE_LOOK } from '#shared/utils/client/scene/tonemap'

describe('agxLookGlsl', () => {
  it('bakes the power and saturation into the look step', () => {
    const glsl = agxLookGlsl({ power: 1.2, saturation: 0.9 })
    expect(glsl).toContain('vec3( 1.2000 )')
    expect(glsl).toContain('0.9000 * ( val - luma )')
    expect(glsl).toContain('color = agxLook( color );')
  })

  it('refuses a look that is not a curve', () => {
    expect(() => agxLookGlsl({ power: 0, saturation: 1 })).toThrow(/positive power/)
    expect(() => agxLookGlsl({ power: 1, saturation: -1 })).toThrow(/non-negative saturation/)
  })
})

describe('installAgXLook', () => {
  it("finds three's CustomToneMapping placeholder, fills it once, and keeps the first look", () => {
    const hook = 'vec3 CustomToneMapping( vec3 color ) { return color; }'
    expect(ShaderChunk.tonemapping_pars_fragment).toContain(hook)

    installAgXLook()
    const chunk = ShaderChunk.tonemapping_pars_fragment
    expect(chunk).not.toContain(hook)
    expect(chunk).toContain(`vec3( ${SCENE_LOOK.power.toFixed(4)} )`)
    expect(chunk).toContain(`${SCENE_LOOK.saturation.toFixed(4)} * ( val - luma )`)
    // The helpers the body calls are three's own, declared earlier in the same chunk.
    expect(chunk.indexOf('agxDefaultContrastApprox')).toBeLessThan(chunk.indexOf('agxLook('))

    installAgXLook({ ...SCENE_LOOK })
    expect(ShaderChunk.tonemapping_pars_fragment).toBe(chunk)
    expect(() => installAgXLook({ power: 1, saturation: 1 })).toThrow(/already installed/)
    expect(ShaderChunk.tonemapping_pars_fragment).toBe(chunk)
  })
})
