import UnifiedCard, { CardArtworkFrame, CompactCardArtwork } from '../UnifiedCard'
import clsx from 'clsx'
import { CARD_DISPLAY_VARIANTS } from './tokens'

const ARTWORK_ONLY_VARIANTS = new Set(['carousel', 'ranking'])

/**
 * Public card-display entry point for feature code.
 *
 * Add genuinely new visual behavior here, document it, and add it to the
 * gallery. Do not assemble page-specific card frames in feature pages.
 */
export default function CardDisplay({ variant = 'grid', ...props }) {
  if (!CARD_DISPLAY_VARIANTS.includes(variant)) {
    throw new Error(`Unsupported CardDisplay variant: ${variant}`)
  }

  if (variant === 'artwork') return <CardArtworkFrame {...props} />
  if (variant === 'compact-artwork') return <CompactCardArtwork {...props} />
  if (variant === 'comparison') {
    return <CardArtworkFrame {...props} className={clsx('unified-card-frame-comparison', props.className)} />
  }

  return (
    <UnifiedCard
      {...props}
      compact={ARTWORK_ONLY_VARIANTS.has(variant) || props.compact}
      interactive={props.interactive ?? Boolean(props.onClick || props.onSelect)}
      showStateIndicators={props.showStateIndicators ?? true}
    />
  )
}
