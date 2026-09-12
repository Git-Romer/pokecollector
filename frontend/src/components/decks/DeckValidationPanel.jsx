import { AlertCircle, AlertTriangle, CheckCircle, ChevronDown, Info } from 'lucide-react'
import { useState } from 'react'

const iconFor = check => check.status === 'pass' ? CheckCircle : check.severity === 'warning' ? AlertTriangle : check.severity === 'info' ? Info : AlertCircle
const toneFor = check => check.status === 'pass' ? 'text-green' : check.severity === 'warning' ? 'text-yellow' : check.severity === 'info' ? 'text-text-muted' : 'text-brand-red'

export default function DeckValidationPanel({ validation, t, compact = false }) {
  const [expanded, setExpanded] = useState(false)
  if (!validation) return null
  const errors = validation.errors.length
  const label = (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), t(key))
  if (compact) return <span className={`text-xs font-semibold ${validation.valid ? 'text-green' : 'text-brand-red'}`}>{validation.valid ? t('decks.validationValid') : label('decks.validationErrors', { count: errors })}</span>
  return <section className="card space-y-3"><button type="button" className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}><div><h2 className="font-semibold text-text-primary">{t('decks.validationTitle')}</h2><p className={`text-xs font-medium ${validation.valid ? 'text-green' : 'text-brand-red'}`}>{validation.valid ? t('decks.validationValid') : label('decks.validationErrors', { count: errors })}</p></div><ChevronDown size={18} className={`text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`} /></button><div className="space-y-2">{validation.checks.map(check => {
    const Icon = iconFor(check)
    return <div key={check.code} className="text-sm"><p className={`flex items-start gap-2 ${toneFor(check)}`}><Icon size={16} className="mt-0.5 shrink-0" /><span>{check.message}</span></p>{expanded && check.details?.violations?.map(item => <p key={item.name} className="ml-6 mt-1 text-xs text-text-secondary">{item.name}: {item.quantity}</p>)}{expanded && check.details?.cards?.map(item => <p key={item.entry_id} className="ml-6 mt-1 text-xs text-text-secondary">{item.name}: {item.missing} {t('decks.missingLabel')}</p>)}{expanded && check.details?.illegal_cards?.map(item => <p key={item.entry_id} className="ml-6 mt-1 text-xs text-text-secondary">{item.name}</p>)}</div>
  })}</div></section>
}
