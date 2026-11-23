import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CardArtworkFrame } from './UnifiedCard'

const queryState = vi.hoisted(() => ({ useQuery: vi.fn() }))
const settingsState = vi.hoisted(() => ({ enabled: false }))

vi.mock('@tanstack/react-query', async importOriginal => {
  const actual = await importOriginal()
  return { ...actual, useQuery: queryState.useQuery }
})

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    settings: { holo_effects_enabled: settingsState.enabled ? 'true' : 'false' },
    t: key => key,
  }),
}))

const effect = {
  maskUrl: 'blob:mask',
  foilMapUrl: 'blob:foil-map',
  foilProfile: 'vstar',
  baseImageSha256: 'b'.repeat(64),
}
const card = {
  id: 'sv1-1_en',
  card_id: 'sv1-1_en',
  tcg_card_id: 'sv1-1',
  lang: 'en',
  images_large: 'https://assets.tcgdex.net/en/sv/sv1/1/high.webp',
}
const largeProxy = '/api/images/card/sv1-1_en/large'

function renderFrame(props = {}) {
  return renderToStaticMarkup(createElement(CardArtworkFrame, {
    card,
    image: largeProxy,
    alt: 'Pikachu',
    variantEffectSource: 'Holo',
    ...props,
  }))
}

describe('Holo renderer integration', () => {
  beforeEach(() => {
    settingsState.enabled = true
    queryState.useQuery.mockReset()
    queryState.useQuery.mockReturnValue({ data: effect })
  })

  it('layers the published mask and foil map only on an opted-in Holo official large proxy image', () => {
    const markup = renderFrame()

    expect(queryState.useQuery).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }), expect.any(Object))
    expect(markup).toContain('holo-effect-layer')
    expect(markup).toContain('pc-holo-card__shine')
    expect(markup).toContain('pc-holo-card__glare')
    expect(markup).toContain('data-holo-profile="vstar"')
    expect(markup).not.toContain('background-image:url(blob:foil-map)')
    expect(markup).toContain('src="/api/images/card/sv1-1_en/large"')
  })

  it.each([
    ['custom card', { card: { ...card, is_custom: true } }],
    ['missing official large artwork', { card: { ...card, images_large: null } }],
    ['user photo', { image: 'blob:owner-photo' }],
    ['non-holo variant', { variantEffectSource: 'Normal' }],
    ['removed variant', { variantEffectSource: 'Special' }],
  ])('does not load an effect for %s', (_name, props) => {
    const markup = renderFrame(props)

    expect(queryState.useQuery).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }), expect.any(Object))
    expect(markup).not.toContain('holo-effect-layer')
  })

  it.each([
    { image: '/api/images/card/sv1-1_en/small' },
    { thumbnail: true },
  ])('uses the verified large printing for passive collection artwork %j', props => {
    const markup = renderFrame(props)
    const [options] = queryState.useQuery.mock.calls[0]
    expect(options.enabled).toBe(true)
    expect(options.queryKey).toContain('Holo')
    expect(options.queryKey.at(-1)).toBe(largeProxy)
    expect(markup).toContain('pc-holo-card__shine')
  })

  it.each([
    [{ owned_variants: [{ variant: 'Holo', quantity: 1 }] }, 'Holo'],
    [{ owned_variants: [{ variant: 'Normal', quantity: 1 }, { variant: 'Reverse Holo', quantity: 1 }] }, 'Reverse Holo'],
  ])('uses the existing representative finish for grouped artwork', (variantEffectSource, expectedVariant) => {
    const markup = renderFrame({ variantEffectSource })
    const [options] = queryState.useQuery.mock.calls[0]
    expect(options.enabled).toBe(true)
    expect(options.queryKey).toContain(expectedVariant)
    expect(markup).toContain('holo-effect-layer')
  })

  it('does not load effects while the per-user preference is off', () => {
    settingsState.enabled = false
    const markup = renderFrame()

    expect(queryState.useQuery).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }), expect.any(Object))
    expect(markup).not.toContain('holo-effect-layer')
  })
})
