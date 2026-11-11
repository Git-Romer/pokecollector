// Public-site adapter. Foil profiles and motion are the actual collection implementation.
import { attachHoloMotion } from './utils/holoMotion'
import './vendor/pokemon-cards-css/scoped.css'
import './components/HoloEffectOverlay.css'
import './holo-preview.css'
export { searchPublicCards, normalizeSearchText, textIncludes } from './utils/publicCardSearch'

export function mount(container, { imageUrl, effect, card, mode = 'subtle', alt = '' }) {
  const host = document.createElement('span')
  host.className = 'collection-holo-surface'
  host.dataset.holoHost = ''
  const rotator = document.createElement('span'); rotator.dataset.holoRotator = ''
  const art = document.createElement('span'); art.dataset.holoArtwork = ''
  const image = document.createElement('img'); image.src = imageUrl; image.alt = alt
  image.draggable = false; image.decoding = 'async'
  const layer = document.createElement('span'); layer.className = 'holo-effect-layer'; layer.setAttribute('aria-hidden', 'true')
  for (const name of ['shine', 'glare']) {
    const span = document.createElement('span'); span.className = `pc-holo-card__${name}`; layer.append(span)
  }
  art.append(image, layer); rotator.append(art); host.append(rotator); container.replaceChildren(host)
  const dispose = attachHoloMotion(layer, effect, card, mode)
  return () => { dispose?.(); host.remove() }
}
