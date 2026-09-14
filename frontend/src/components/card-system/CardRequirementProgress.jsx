import { Check } from 'lucide-react'

/** Shared owned/required badge used by every planned Card List tile. */
export default function CardRequirementProgress({ ownedQuantity, requiredQuantity, progressLabel }) {
  const owned = Math.max(0, Number(ownedQuantity) || 0)
  const required = Math.max(1, Number(requiredQuantity) || 1)
  const complete = owned >= required

  return (
    <span
      title={progressLabel}
      aria-label={progressLabel}
      className={complete
        ? 'inline-flex items-center justify-center rounded-full border border-green/40 bg-green/90 p-1 text-white shadow-sm'
        : 'inline-flex items-center rounded-full border border-white/15 bg-bg-elevated px-1.5 py-0.5 text-[10px] font-bold leading-none text-text-secondary shadow-sm'}
    >
      {complete ? <Check size={10} strokeWidth={3} aria-hidden /> : `${owned}/${required}`}
    </span>
  )
}
