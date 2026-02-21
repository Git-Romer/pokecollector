/**
 * Card — Premium glass surface card container.
 *
 * Props:
 *   variant   {string}  — 'default' (glass) | 'solid' | 'elevated'
 *   className {string}  — extra Tailwind classes
 *   onClick   {fn}      — if provided, card is clickable (adds hover state)
 *   padding   {string}  — 'none' | 'sm' | 'md' (default) | 'lg'
 *   children  {node}
 */
export default function Card({ className = '', onClick, padding = 'md', variant = 'default', children }) {
  const paddingClass = {
    none: 'p-0',
    sm:   'p-3',
    md:   'p-4',
    lg:   'p-5',
  }[padding] || 'p-4'

  const variantStyles = {
    default: 'card',
    solid: 'bg-bg-card border border-border rounded-2xl',
    elevated: 'stat-card',
  }

  const base = [
    variant === 'default' ? '' : variantStyles[variant],
    paddingClass,
    'transition-all duration-200',
  ]

  if (variant === 'default') {
    // Use the glass .card class
    base.unshift('card')
  }

  if (onClick) {
    base.push('cursor-pointer')
    if (variant === 'default') {
      base.push('hover:border-brand-red/30 hover:shadow-glow active:bg-bg-elevated')
    }
  }

  return (
    <div
      className={[...base, className].filter(Boolean).join(' ')}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => e.key === 'Enter' && onClick(e) : undefined}
    >
      {children}
    </div>
  )
}
