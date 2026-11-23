import { useEffect } from 'react'
import { useSettings } from '../contexts/SettingsContext'
import { holoDeviceMotion } from '../utils/holoDeviceMotion'

// Starts with the app, not with individual cards. Native permission decisions
// are reused; browsers requiring activation defer their own prompt to a tap.
export default function HoloDeviceMotionController() {
  const { settings } = useSettings()
  const enabled = settings?.holo_effects_enabled === 'true'
  useEffect(() => {
    if (!enabled || !holoDeviceMotion) return undefined
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let stop = () => {}
    const sync = () => { stop(); stop = reduced.matches ? () => {} : holoDeviceMotion.start() }
    sync()
    reduced.addEventListener('change', sync)
    return () => { stop(); reduced.removeEventListener('change', sync) }
  }, [enabled])
  return null
}
