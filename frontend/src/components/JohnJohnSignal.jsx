import { Button, Tooltip } from '@fluentui/react-components'
import { useSettings } from '../contexts/SettingsContext'

/**
 * `decorative` renders the mark without the button wrapper. The rail footer
 * pairs the glyph with its own visible caption, so wrapping it in a second
 * control would put two identically-named buttons in the tab order for the
 * one action the toolbar copy already owns.
 */
export default function JohnJohnSignal({ noteCount = 0, onOpenNotes, decorative = false }) {
  const { t } = useSettings()
  const canOpenNotes = noteCount > 0 && onOpenNotes
  const label = canOpenNotes ? t('archive.openNotes') : t('archive.keepingWatch')

  if (decorative) {
    return (
      <span className="john-john-signal" aria-hidden="true">
        <span className="john-john-mark">∞</span>
        <span className="john-john-presence" />
      </span>
    )
  }

  return (
    <Tooltip content={label} relationship="label">
      <Button
        appearance="subtle"
        aria-label={label}
        disabled={!canOpenNotes}
        onClick={canOpenNotes ? onOpenNotes : undefined}
        className="john-john-signal"
      >
        <span aria-hidden="true" className="john-john-mark">∞</span>
        <span aria-hidden="true" className="john-john-presence" />
      </Button>
    </Tooltip>
  )
}
