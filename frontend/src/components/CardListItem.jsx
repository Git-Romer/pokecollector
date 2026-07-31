import clsx from 'clsx'
import { CompactCardArtwork } from './UnifiedCard'

export function CompactCardIdentity({
  image,
  card = {},
  name,
  subtext,
  setNumber,
  languageLabel,
  variantEffectSource = null,
  details,
  onClick,
  className = '',
}) {
  const Component = onClick ? 'button' : 'div'

  return (
    <Component
      type={onClick ? 'button' : undefined}
      className={clsx(
        'flex min-w-0 items-center gap-3 text-left',
        onClick && 'rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red/70',
        className,
      )}
      onClick={onClick}
    >
      <CompactCardArtwork
        card={card}
        image={image}
        alt={name}
        variantEffectSource={variantEffectSource}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {name && <p className="truncate text-sm font-semibold leading-tight text-text-primary">{name}</p>}
        {(setNumber || languageLabel) && (
          <p className="flex min-w-0 items-center gap-1.5 text-xs leading-tight">
            {setNumber && <span className="truncate font-mono font-bold text-brand-red">{setNumber}</span>}
            {languageLabel && <span className="truncate text-text-muted">{languageLabel}</span>}
          </p>
        )}
        {subtext && <p className="truncate text-xs leading-tight text-text-muted">{subtext}</p>}
        {details}
      </div>
    </Component>
  )
}

/**
 * CardListItem — Reusable card row for Collection, Wishlist, Search results, etc.
 *
 * Layout (mobile-first, no overflow):
 *   [Shared compact artwork] [Content flex-1 min-w-0] [Value flex-shrink-0]
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
 *   variantEffectSource {string|object|array} — exact/grouped variant data for shine
 */
export default function CardListItem({
  image,
  card = {},
  name,
  subtext,
  setNumber,
  languageLabel,
  badges = [],
  value,
  valueSecondary,
  onClick,
  rightAction,
  className = '',
  variantEffectSource = null,
}) {
  return (
    <div
      className={clsx(
        'flex items-center gap-3 p-3 rounded-xl border border-transparent',
        'bg-[rgba(20,20,40,0.6)] backdrop-blur-xl',
        'border-[rgba(255,255,255,0.05)]',
        onClick && 'cursor-pointer hover:border-brand-red/30 hover:bg-bg-elevated hover:shadow-glow active:bg-bg-elevated transition-all duration-200',
        onClick && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red/70',
        className
      )}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => e.key === 'Enter' && onClick(e) : undefined}
    >
      <CompactCardIdentity
        className="flex-1"
        card={card}
        image={image}
        name={name}
        subtext={subtext}
        setNumber={setNumber}
        languageLabel={languageLabel}
        variantEffectSource={variantEffectSource}
        details={badges.length > 0 ? (
          <div className="flex flex-wrap gap-1 mt-0.5">
            {badges.map((badge, i) => (
              <span
                key={i}
                className={clsx(
                  'inline-flex min-w-0 max-w-full items-center justify-center px-1.5 py-0.5 rounded-full text-center text-[10px] font-medium leading-tight whitespace-normal break-words',
                  badgeVariantClass(badge.variant)
                )}
              >
                {badge.label}
              </span>
            ))}
          </div>
        ) : null}
      />

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
