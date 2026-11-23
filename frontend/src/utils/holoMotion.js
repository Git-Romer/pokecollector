import { holoDeviceMotion } from './holoDeviceMotion'

const profiles = {
  swholo: 'rare holo', cosmos: 'rare holo cosmos', reverse: 'rare reverse holo',
  amazing: 'amazing rare', radiant: 'radiant rare', sunpillar: 'rare holo v',
  vfullart: 'rare ultra', vmax: 'rare holo vmax', vstar: 'rare holo vstar',
  trainerfullart: 'rare ultra', rainbow: 'rare rainbow', rainbowalt: 'rare rainbow alt',
  swsecret: 'rare secret', 'trainer-gallery': 'rare holo', 'trainer-gallery-v': 'rare holo v',
  'trainer-gallery-vmax': 'rare holo vmax', 'trainer-gallery-secret': 'rare secret',
  shinyrare: 'rare shiny', shinyv: 'rare shiny v', shinyvmax: 'rare shiny vmax',
}

// Canonical motion engine shared by collection React surfaces and public previews.
export function attachHoloMotion(element, effect, card, mode = 'subtle') {
  if (!effect || !element) return undefined
  const art = element.closest('[data-holo-artwork]')
  const host = art?.closest('[data-holo-host]')
  const rotator = host?.querySelector('[data-holo-rotator]')
  if (!art || !host || !rotator) return undefined
  const profile = effect.foilProfile || 'swholo'
  const trainer = String(card.category || '').toLowerCase() === 'trainer' || /trainer|orders|supporter/i.test(`${card.rarity || ''} ${card.name || ''}`)
  const attrs = {
    'data-rarity': profiles[profile] || profiles.swholo,
    'data-supertype': trainer ? 'trainer' : 'pokémon',
    'data-subtypes': trainer ? 'supporter' : String(card.stage || 'basic').toLowerCase(),
    'data-trainer-gallery': String(profile.startsWith('trainer-gallery')),
    'data-number': String(card.localId || card.number || ''),
    'data-set': String(card.set?.id || card.set_id || ''), 'data-holo-mode': mode,
  }
  for (const [key, value] of Object.entries(attrs)) art.setAttribute(key, value)
  art.classList.add('pc-holo-card', 'interactive', 'masked')
  if (trainer) art.classList.add('trainer')
  const previousStyle = art.getAttribute('style')
  art.style.setProperty('--mask', `url("${effect.maskUrl}")`)
  art.style.setProperty('--foil', `url("${effect.foilMapUrl}")`)
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  let frame = 0, visible = false, pointing = false, last = 0, disposed = false
  let pointer = { x: .5, y: .5 }, tiltX = 0, tiltY = 0
  let device = holoDeviceMotion?.get() ?? null
  const idleOpacity = mode === 'interactive' ? .25 : 0
  let lightX = .5, lightY = .5, lightOpacity = idleOpacity
  const set = (x, y, opacity) => {
    const center = Math.min(1, Math.hypot(x - .5, y - .5) * 2)
    const values = {
      '--pointer-x': `${x * 100}%`, '--pointer-y': `${y * 100}%`,
      '--background-x': `${37 + x * 26}%`, '--background-y': `${33 + y * 34}%`,
      '--pointer-from-center': String(center), '--pointer-from-left': String(x),
      '--pointer-from-top': String(y), '--card-opacity': String(opacity),
      '--cosmosbg': 'center',
    }
    for (const [key, value] of Object.entries(values)) art.style.setProperty(key, value)
    const tilting = (pointing || device) && !reduced.matches
    // Grid cards share the foil interaction, but move at most 2° per axis.
    const xRange = mode === 'interactive' ? 20 : 4
    const yRange = mode === 'interactive' ? 24 : 4
    tiltX += ((tilting ? (y - .5) * -xRange : 0) - tiltX) * .22
    tiltY += ((tilting ? (x - .5) * yRange : 0) - tiltY) * .22
    const transform = !reduced.matches && (Math.abs(tiltX) > .01 || Math.abs(tiltY) > .01)
      ? `perspective(900px) rotateX(${tiltX}deg) rotateY(${tiltY}deg)` : ''
    if (rotator.style.transform !== transform) rotator.style.transform = transform
  }
  const tick = time => {
    frame = 0
    if (disposed || !visible || document.hidden || reduced.matches) return
    if (time - last >= 16) {
      const dt = Math.min(64, last ? time - last : 16)
      last = time
      const input = pointing ? pointer : device
      const x = input?.x ?? .5, y = input?.y ?? .5, opacity = input ? .85 : idleOpacity
      // Ease the shader as well as the geometry. A slower release avoids
      // cutting the foil off while the card is still returning to neutral.
      const alpha = 1 - Math.exp(-dt / (input ? 120 : 180))
      lightX += (x - lightX) * alpha
      lightY += (y - lightY) * alpha
      lightOpacity += (opacity - lightOpacity) * alpha
      if (Math.abs(x - lightX) < .001) lightX = x
      if (Math.abs(y - lightY) < .001) lightY = y
      if (Math.abs(opacity - lightOpacity) < .001) lightOpacity = opacity
      set(lightX, lightY, lightOpacity)
    }
    if (pointing || device || lightOpacity !== idleOpacity || lightX !== .5 || lightY !== .5 || Math.abs(tiltX) > .01 || Math.abs(tiltY) > .01) frame = requestAnimationFrame(tick)
  }
  const schedule = () => {
    if (reduced.matches || !visible || document.hidden) {
      cancelAnimationFrame(frame); frame = 0
      // The first pointer event can precede IntersectionObserver's initial
      // callback. Pause offscreen work without discarding that real input.
      if (reduced.matches || document.hidden) pointing = false
      tiltX = 0; tiltY = 0; lightX = .5; lightY = .5; lightOpacity = idleOpacity
      set(.5, .5, idleOpacity)
    } else if (!frame) { last = 0; frame = requestAnimationFrame(tick) }
  }
  const move = event => {
    if (reduced.matches || event.pointerType === 'touch' || event.buttons) return
    const box = host.getBoundingClientRect()
    if (!box.width || !box.height) return
    pointing = true
    pointer = { x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) }
    schedule()
  }
  const leave = () => { pointing = false; schedule() }
  set(.5, .5, idleOpacity)
  const unsubscribeDevice = holoDeviceMotion?.subscribe(value => { device = value; schedule() })
  const observer = new IntersectionObserver(entries => { visible = entries.some(e => e.isIntersecting); schedule() })
  observer.observe(host)
  host.addEventListener('pointermove', move); host.addEventListener('pointerleave', leave); host.addEventListener('pointercancel', leave)
  document.addEventListener('visibilitychange', schedule); reduced.addEventListener('change', schedule)
  return () => {
    disposed = true; cancelAnimationFrame(frame); observer.disconnect(); unsubscribeDevice?.()
    host.removeEventListener('pointermove', move); host.removeEventListener('pointerleave', leave); host.removeEventListener('pointercancel', leave)
    document.removeEventListener('visibilitychange', schedule); reduced.removeEventListener('change', schedule)
    art.classList.remove('pc-holo-card', 'interactive', 'masked')
    if (trainer) art.classList.remove('trainer')
    for (const key of Object.keys(attrs)) art.removeAttribute(key)
    if (previousStyle === null) art.removeAttribute('style')
    else art.setAttribute('style', previousStyle)
    rotator.style.transform = ''
  }
}
