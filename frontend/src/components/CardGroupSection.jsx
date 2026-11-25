/**
 * Collapsible species/section header used by the Collection's grouped grid and
 * the Analytics species list.
 *
 * The whole header is one button, so `aria-expanded` reflects the panel, the
 * focus ring and keyboard activation come from the native element, and the
 * sprite is purely decorative. Callers own the rows/tiles inside the panel so
 * both views keep their existing card rendering.
 */
import { useState } from 'react'
import clsx from 'clsx'
import { ChevronDown, Layers } from 'lucide-react'

export default function CardGroupSection({
  groupId,
  heading,
  eyebrow = null,
  summary = null,
  spriteSrc = null,
  totalValue = null,
  formatPrice = null,
  open = false,
  onToggle,
  children,
  className = '',
  contentClassName = 'border-t border-border/60',
}) {
  const [spriteFailed, setSpriteFailed] = useState(false)
  const panelId = `card-group-panel-${groupId}`

  return (
    <section className={clsx('rounded-2xl border border-border/70 bg-bg-card/40 backdrop-blur-xs', className)}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full min-w-0 items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-bg-elevated/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-red/70"
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center">
          {spriteSrc && !spriteFailed ? (
            <img
              src={spriteSrc}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setSpriteFailed(true)}
              className="h-10 w-10 object-contain [image-rendering:pixelated]"
            />
          ) : spriteSrc ? (
            <img src="/pokeball.svg" alt="" className="h-7 w-7 opacity-40" />
          ) : (
            <span className="grid h-9 w-9 place-items-center rounded-full bg-bg-elevated text-text-muted">
              <Layers size={16} aria-hidden />
            </span>
          )}
        </span>

        <span className="min-w-0 flex-1">
          {eyebrow && (
            <span className="block text-[10px] font-black tracking-[0.15em] text-text-muted">{eyebrow}</span>
          )}
          <span className="block truncate text-sm font-bold text-text-primary">{heading}</span>
          {summary && <span className="block truncate text-xs text-text-muted">{summary}</span>}
        </span>

        <span className="flex shrink-0 items-center gap-2">
          {totalValue != null && formatPrice && (
            <span className="text-sm font-bold text-green">{formatPrice(totalValue)}</span>
          )}
          <ChevronDown
            size={16}
            aria-hidden
            className={clsx('text-text-muted transition-transform', open && 'rotate-180')}
          />
        </span>
      </button>

      {open && (
        <div id={panelId} className={contentClassName}>
          {children}
        </div>
      )}
    </section>
  )
}
