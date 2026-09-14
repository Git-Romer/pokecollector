import Badge from './ui/Badge'
import { printingDetailNames } from '../utils/printingDetails'

export default function PrintingDetailBadges({ details, limit = null, className = '' }) {
  const names = printingDetailNames(details)
  if (!names.length) return null
  const visible = limit == null ? names : names.slice(0, limit)
  const hiddenCount = names.length - visible.length

  return (
    <div className={`flex min-w-0 flex-wrap gap-1 ${className}`.trim()}>
      {visible.map(name => <Badge key={name} variant="blue" size="sm">{name}</Badge>)}
      {hiddenCount > 0 && <Badge variant="gray" size="sm">+{hiddenCount}</Badge>}
    </div>
  )
}
