import CardImage from './CardImage'
import clsx from 'clsx'

/**
 * CardListItem — Reusable card row for Collection, Wishlist, Search results, etc.
 *
 * Layout (mobile-first, no overflow):
 *   [Image 48×68] [Content flex-1 min-w-0] [Value flex-shrink-0]
 *
 * Props:
 *   image       {string}    — card image URL
 *   name        {string}    — card name (truncated with ellipsis)
 *   subtext     {string}    — secondary line (set name etc.) — truncated
 *   badges      {Array}     — [{ label, variant }] rendered with Badge style
 *   value       {string}    — primary value (price)
 *   valueSecondary {string} — secondary value line
 *   onClick     {fn}        — makes row clickable
 *   rightAction {node}      — optional right-side action element (e.g. delete button)
 *   className   {string}
 */
export default function CardListItem({
  image,
  name,
  subtext,
  badges = [],
  value,
  valueSecondary,
  onClick,
  rightAction,
  className = '',
}) {
  return (
    <div
      className={clsx(
        'flex items-center gap-3 p-3 rounded-xl border border-transparent',
        'bg-[rgba(20,20,40,0.6)] backdrop-blur-xl',
        'border-[rgba(255,255,255,0.05)]',
        onClick && 'cursor-pointer hover:border-brand-red/30 hover:bg-bg-elevated hover:shadow-glow active:bg-bg-elevated transition-all duration-200',
        className
      )}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => e.key === 'Enter' && onClick(e) : undefined}
    >
      {/* Card thumbnail */}
      <div className="flex-shrink-0 w-12 h-[68px] rounded-lg overflow-hidden bg-bg-elevated shadow-lg ring-1 ring-white/5">
        <CardImage src={image} alt={name} className="w-full h-full object-cover" />
      </div>

      {/* Content — flex-1 min-w-0 so it shrinks and wraps instead of overflowing */}
      <div className="flex-1 flex flex-col gap-0.5" style={{ minWidth: 0, overflow: "visible" }}>
        {/* Card name — truncated single line */}
        {name && (
          <p className="text-sm font-semibold text-text-primary truncate leading-tight">
            {name}
          </p>
        )}

        {/* Subtext — set name, etc. — also truncated */}
        {subtext && (
          <p className="text-xs text-text-muted truncate leading-tight">
            {subtext}
          </p>
        )}

        {/* Badges row */}
        {badges.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-0.5">
            {badges.map((badge, i) => (
              <span
                key={i}
                className={clsx(
                  'inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium leading-none flex-shrink-0',
                  badgeVariantClass(badge.variant)
                )}
              >
                {badge.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Right: value + optional action */}
      <div className="flex-shrink-0 flex items-center gap-2">
        {(value || valueSecondary) && (
          <div className="text-right">
            {value && (
              <p className="text-sm font-bold text-text-primary leading-tight">
                {value}
              </p>
            )}
            {valueSecondary && (
              <p className="text-xs text-text-muted leading-tight">
                {valueSecondary}
              </p>
            )}
          </div>
        )}

        {rightAction && (
          <div className="flex-shrink-0">
            {rightAction}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Map a variant name to Tailwind classes (mirrors Badge.jsx)
 */
function badgeVariantClass(variant) {
  const map = {
    red:    'bg-brand-red/20 text-brand-red',
    green:  'bg-green/20 text-green',
    yellow: 'bg-yellow/20 text-yellow',
    blue:   'bg-blue/20 text-blue',
    gray:   'bg-bg-elevated text-text-muted',
    purple: 'bg-purple-500/20 text-purple-400',
    orange: 'bg-orange-500/20 text-orange-400',
    pink:   'bg-pink-500/20 text-pink-400',
    teal:   'bg-teal-500/20 text-teal-400',
    gold:   'bg-yellow-800/30 text-yellow-400 border border-yellow-600/40',
  }
  return map[variant] || map.gray
}
