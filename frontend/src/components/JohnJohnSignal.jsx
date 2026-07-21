import { Button, Tooltip } from '@fluentui/react-components'
import { useSettings } from '../contexts/SettingsContext'

export default function JohnJohnSignal({ noteCount = 0, onOpenNotes }) {
  const { t } = useSettings()
  const canOpenNotes = noteCount > 0 && onOpenNotes
  const label = canOpenNotes ? t('archive.openNotes') : t('archive.keepingWatch')

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
