import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** Keep the catalogue label intact; the translation is optional context. */
export default function SetName({ set, language }) {
  const id = useId()
  const trigger = useRef(null)
  const tooltip = useRef(null)
  const [anchor, setAnchor] = useState(null)
  const translated = set.translated_name_lang === language && set.translated_name?.trim()
  const available = translated && translated !== set.name
  const show = () => setAnchor(trigger.current.getBoundingClientRect())
  const hide = () => setAnchor(null)

  useEffect(() => {
    if (!anchor) return
    const outside = event => {
      if (!trigger.current?.contains(event.target) && !tooltip.current?.contains(event.target)) hide()
    }
    const escape = event => { if (event.key === 'Escape') hide() }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', hide)
    window.addEventListener('scroll', hide, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', hide)
      window.removeEventListener('scroll', hide, true)
    }
  }, [anchor])

  const className = 'font-bold text-text-primary text-sm leading-tight truncate flex-1 min-w-0'
  if (!available) return <p className={className}>{set.name}</p>
  return <>
    <button
      ref={trigger}
      type="button"
      className={`${className} text-left underline decoration-dotted decoration-text-muted underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-red`}
      aria-describedby={anchor ? id : undefined}
      onPointerEnter={event => { if (event.pointerType === 'mouse') show() }}
      onPointerLeave={event => { if (event.pointerType === 'mouse' && !tooltip.current?.contains(event.relatedTarget)) hide() }}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) show() }}
      onBlur={hide}
      onClick={event => { event.stopPropagation(); if (anchor) hide(); else show() }}
    >{set.name}</button>
    {anchor && createPortal(<span
      ref={tooltip}
      id={id}
      role="tooltip"
      lang={language}
      className="fixed z-[100] rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-primary shadow-lg break-words"
      style={{
        width: 'max-content', maxWidth: Math.min(280, window.innerWidth - 16),
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - Math.min(280, window.innerWidth - 16) - 8)),
        ...(anchor.bottom + 80 < window.innerHeight ? { top: anchor.bottom } : { bottom: window.innerHeight - anchor.top }),
      }}
      onMouseLeave={event => { if (!trigger.current?.contains(event.relatedTarget)) hide() }}
      onClick={event => event.stopPropagation()}
    >{translated}</span>, document.body)}
  </>
}
