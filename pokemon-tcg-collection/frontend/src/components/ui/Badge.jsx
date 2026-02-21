/**
 * Badge — Small rounded status pill.
 *
 * Props:
 *   variant   {'red'|'green'|'yellow'|'blue'|'gray'|'purple'} — color scheme
 *   size      {'sm'|'md'}  — default 'md'
 *   className {string}     — extra classes
 *   children  {node}
 */
export default function Badge({ variant = 'gray', size = 'md', className = '', children }) {
  const variantClass = {
    red:    'bg-brand-red/20 text-brand-red',
    green:  'bg-green/20 text-green',
    yellow: 'bg-yellow/20 text-yellow',
    blue:   'bg-blue/20 text-blue',
    gray:   'bg-bg-elevated text-text-muted',
    purple: 'bg-purple-500/20 text-purple-400',
    orange: 'bg-orange-500/20 text-orange-400',
    pink:   'bg-pink-500/20 text-pink-400',
    teal:   'bg-teal-500/20 text-teal-400',
  }[variant] || 'bg-bg-elevated text-text-muted'

  const sizeClass = {
    sm: 'px-1.5 py-0 text-[10px]',
    md: 'px-2 py-0.5 text-xs',
  }[size] || 'px-2 py-0.5 text-xs'

  return (
    <span
      className={[
        'inline-flex items-center rounded-full font-medium leading-none whitespace-nowrap flex-shrink-0',
        variantClass,
        sizeClass,
        className,
      ].join(' ')}
    >
      {children}
    </span>
  )
}
