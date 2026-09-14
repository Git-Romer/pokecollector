import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowLeftRight, CheckCircle2, GitCompare, Layers3, ShieldCheck, Sparkles, Target } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { compareDecks, getDecks } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { DECK_COMPARISON_COLORS, DECK_COMPOSITION_COLORS, DeckAnalyticsSection, DeckMetricGrid, DeckPairLegend, DeckPairedBar, DeckSideMetricCard } from '../components/decks/DeckAnalyticsVisuals'

const pct = value => `${(Number(value || 0) * 100).toFixed(1)}%`
const delta = value => `${value > 0 ? '+' : ''}${value}`
const COMPOSITION_KEYS = { Pokemon: 'decks.Pokemon', Trainer: 'decks.Trainer', Energy: 'decks.Energy', Other: 'decks.Other' }
const VALIDATION_KEYS = { deck_size: 'decks.validationDeckSize', basic_pokemon: 'decks.validationBasicPokemon', copy_limit: 'decks.validationCopyLimit', ownership: 'decks.validationOwnership', format_legality: 'decks.validationFormatLegality' }
const STATUS_KEYS = { pass: 'decks.validationStatusPass', fail: 'decks.validationStatusFail', unavailable: 'decks.validationStatusUnavailable' }
const EFFECT_KEYS = { draw: 'effects.draw', pokemon_search: 'effects.pokemonSearch', energy_search: 'effects.energySearch', trainer_search: 'effects.trainerSearch', general_search: 'effects.generalSearch', energy_acceleration: 'effects.energyAcceleration', energy_recovery: 'effects.energyRecovery', pokemon_recovery: 'effects.pokemonRecovery', trainer_recovery: 'effects.trainerRecovery', general_recovery: 'effects.generalRecovery', switching: 'effects.switching', gust: 'effects.gust', healing: 'effects.healing', damage_boost: 'effects.damageBoost', damage_reduction: 'effects.damageReduction', bench_damage: 'effects.benchDamage', status_condition: 'effects.statusCondition', discard: 'effects.discard', hand_disruption: 'effects.handDisruption', deck_disruption: 'effects.deckDisruption', evolution_acceleration: 'effects.evolutionAcceleration', prize_manipulation: 'effects.prizeManipulation', retreat_support: 'effects.retreatSupport' }
const EFFECT_COLORS = ['#3b82f6', '#ef4444', '#eab308', '#8b5cf6', '#22c55e', '#06b6d4']
const CARD_CHANGE_COLORS = { added: '#22c55e', removed: '#ef4444', changed: '#3b82f6', unchanged: '#64748b' }

const statusText = (check, t) => check?.status ? t(STATUS_KEYS[check.status] || check.status) : t('decks.notAvailableShort')
const formatText = (deck, t) => t(`decks.format${deck?.format || 'Casual'}`)

function DeckIdentity({ deck, side, t }) {
  const valid = Boolean(deck.validation?.valid)
  const progress = Math.min((Number(deck.current_card_count || 0) / Math.max(Number(deck.target_size || 0), 1)) * 100, 100)
  const accent = DECK_COMPARISON_COLORS[side]
  return (
    <article className={`relative overflow-hidden rounded-2xl border border-border bg-bg-card p-4 shadow-card ${side === 'left' ? 'text-right' : ''}`} data-comparison-deck={side}>
      <span className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: accent }} />
      <div className={`flex flex-col gap-2 sm:items-start sm:gap-3 ${side === 'left' ? 'items-end sm:flex-row-reverse' : 'items-start sm:flex-row'}`}>
        <div className="min-w-0 w-full flex-1">
          <p className={`text-[11px] font-black uppercase tracking-wider ${side === 'left' ? 'text-blue' : 'text-violet-400'}`}>{side === 'left' ? t('decks.deckA') : t('decks.deckB')}</p>
          <h2 className="mt-1 break-words text-lg font-black leading-tight text-text-primary sm:text-xl">{deck.name}</h2>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${valid ? 'bg-green/10 text-green' : 'bg-brand-red/10 text-brand-red'}`}>
          {valid ? <CheckCircle2 size={13} aria-hidden /> : <ShieldCheck size={13} aria-hidden />}
          {valid ? t('decks.validShort') : `${deck.validation?.errors?.length || 0} ${t('decks.errorsShort')}`}
        </span>
      </div>
      <div className={`mt-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between sm:gap-3 ${side === 'left' ? 'items-end sm:flex-row-reverse' : 'items-start'}`}>
        <div><span className="whitespace-nowrap"><strong className="text-2xl font-black text-text-primary">{deck.current_card_count}</strong><span className="text-sm text-text-muted"> / {deck.target_size}</span></span><span className="block text-xs text-text-muted sm:inline sm:text-sm"> {t('decks.cards')}</span></div>
        <span className="rounded-lg bg-bg-elevated px-2 py-1 text-xs font-medium text-text-secondary">{formatText(deck, t)}</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg-elevated"><div className={`h-full rounded-full ${side === 'left' ? 'ml-auto' : ''}`} style={{ width: `${progress}%`, backgroundColor: accent }} /></div>
    </article>
  )
}

const StatusPill = ({ check, t }) => <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${check?.status === 'pass' ? 'bg-green/10 text-green' : 'bg-brand-red/10 text-brand-red'}`}>{statusText(check, t)}</span>

const DeckFlowValue = ({ left, right }) => <span className="inline-flex max-w-full items-center gap-1 text-sm font-black sm:text-base"><span className="inline-flex items-center gap-0.5 text-blue"><small className="text-[8px] font-bold">A</small>{left}</span><span className="text-xs font-normal text-text-muted">→</span><span className="inline-flex items-center gap-0.5 text-violet-400"><small className="text-[8px] font-bold">B</small>{right}</span></span>

export default function DeckCompare() {
  const navigate = useNavigate()
  const { t } = useSettings()
  const [params, setParams] = useSearchParams()
  const [showUnchanged, setShowUnchanged] = useState(false)
  const [keyCard, setKeyCard] = useState('')
  const leftId = params.get('left')
  const rightId = params.get('right')
  const { data: decks = [] } = useQuery({ queryKey: ['decks'], queryFn: () => getDecks().then(response => response.data) })
  const { data, isLoading } = useQuery({ queryKey: ['deck-compare', leftId, rightId, keyCard], enabled: Boolean(leftId && rightId && leftId !== rightId), queryFn: () => compareDecks({ left_id: leftId, right_id: rightId, card_name: keyCard || undefined }).then(response => response.data) })
  const choose = (side, value) => setParams(current => { const next = new URLSearchParams(current); next.set(side, value); return next })
  const swap = () => setParams(current => { const next = new URLSearchParams(current); next.set('left', rightId || ''); next.set('right', leftId || ''); return next })
  const deck = data?.decks
  const allCards = data?.cards?.changes || []
  const cards = allCards.filter(card => showUnchanged || card.status !== 'unchanged')
  const cardNames = [...new Set(allCards.map(card => card.name))]
  const effectMax = Math.max(...(data?.effects?.changes || []).flatMap(row => [row.left, row.right]), 1)
  const compositionRows = Object.keys(COMPOSITION_KEYS).map(metric => ({
    metric,
    left: Number(deck?.left?.composition_counts?.[metric] || 0),
    right: Number(deck?.right?.composition_counts?.[metric] || 0),
  }))
  const compositionMax = Math.max(...compositionRows.flatMap(row => [row.left, row.right]), 1)
  const changedCount = allCards.filter(card => card.status === 'changed').length
  const addedCount = allCards.filter(card => card.status === 'added').length
  const basicLeft = data?.probability?.left?.basic_pokemon?.at_least_one || 0
  const basicRight = data?.probability?.right?.basic_pokemon?.at_least_one || 0
  const pairLegend = () => <DeckPairLegend leftName={deck.left.name} rightName={deck.right.name} leftLabel={t('decks.deckA')} rightLabel={t('decks.deckB')} />

  return <div className="space-y-5 pb-8">
    <button className="btn-ghost" onClick={() => navigate(leftId ? `/decks/${leftId}` : '/binders')}><ArrowLeft size={16} /> {leftId ? t('common.back') : t('decks.backToCardLists')}</button>

    <header className="relative overflow-hidden rounded-2xl border border-border bg-bg-card p-5 shadow-card" data-testid="deck-comparison-hero">
      <div className="pointer-events-none absolute -right-12 -top-20 h-56 w-56 rounded-full bg-brand-red/10 blur-3xl" />
      <div className="relative flex items-start gap-4"><span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand-red/10 text-brand-red"><GitCompare size={24} aria-hidden /></span><div><h1 className="text-2xl font-black text-text-primary">{t('decks.compare')}</h1><p className="mt-1 max-w-2xl text-sm text-text-secondary">{t('decks.compareIntro')}</p></div></div>
      <div className="relative mt-5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2 sm:gap-3">
        <label className="min-w-0 text-right text-sm text-blue">{t('decks.deckA')}<select aria-label={t('decks.deckA')} className="select mt-1 w-full text-left" value={leftId || ''} onChange={event => choose('left', event.target.value)}><option value="">{t('decks.chooseDeck')}</option>{decks.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <button type="button" className="btn-secondary mb-0.5 justify-self-center px-2 sm:px-3" onClick={swap} disabled={!leftId || !rightId} aria-label={t('decks.swapDecks')} title={t('decks.swapDecks')}><ArrowLeftRight size={17} aria-hidden /></button>
        <label className="min-w-0 text-sm text-violet-400">{t('decks.deckB')}<select aria-label={t('decks.deckB')} className="select mt-1 w-full" value={rightId || ''} onChange={event => choose('right', event.target.value)}><option value="">{t('decks.chooseDeck')}</option>{decks.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      </div>
    </header>

    {isLoading ? <div className="grid grid-cols-2 gap-3"><div className="skeleton h-40 rounded-xl" /><div className="skeleton h-40 rounded-xl" /></div> : !deck ? <p className="rounded-xl border border-dashed border-border bg-bg-card px-4 py-12 text-center text-sm text-text-muted">{t('decks.chooseDifferentDecks')}</p> : <>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-3">
        <DeckIdentity deck={deck.left} side="left" t={t} />
        <span className="grid h-9 w-9 place-items-center rounded-full border border-border bg-bg-elevated text-[10px] font-black text-text-muted">VS</span>
        <DeckIdentity deck={deck.right} side="right" t={t} />
      </div>

      <DeckMetricGrid className="grid-cols-2 lg:grid-cols-4" items={[
        { label: t('decks.compareChangedCards'), value: changedCount, accent: 'text-blue', icon: ArrowLeftRight },
        { label: t('decks.compareAddedCards'), value: addedCount, accent: 'text-green', icon: CheckCircle2 },
        { label: t('decks.missingCopiesCompare'), value: <DeckFlowValue left={data.ownership.left} right={data.ownership.right} />, accent: 'text-text-primary', icon: ShieldCheck },
        { label: t('decks.basicOpening'), value: <DeckFlowValue left={pct(basicLeft)} right={pct(basicRight)} />, accent: 'text-text-primary', icon: Target },
      ]} />

      <DeckAnalyticsSection title={t('decks.compositionCompare')} description={t('decks.compareCompositionHelp')} icon={Layers3}>
        {pairLegend()}
        <div className="grid gap-3 md:grid-cols-2">{compositionRows.map(row => <DeckPairedBar key={row.metric} testId={row.metric} label={t(COMPOSITION_KEYS[row.metric])} left={row.left} right={row.right} max={compositionMax} color={DECK_COMPOSITION_COLORS[row.metric] || DECK_COMPOSITION_COLORS.Other} leftName={deck.left.name} rightName={deck.right.name} />)}</div>
      </DeckAnalyticsSection>

      <DeckAnalyticsSection title={t('decks.cardChanges')} description={t('decks.compareCardChangesHelp')} icon={ArrowLeftRight} action={<label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-xs text-text-secondary"><input type="checkbox" checked={showUnchanged} onChange={event => setShowUnchanged(event.target.checked)} /> {t('decks.showUnchanged')}</label>}>
        {pairLegend()}
        {cards.length > 0 ? <div className="grid gap-2 md:grid-cols-2">{cards.map(card => { const color = CARD_CHANGE_COLORS[card.status] || CARD_CHANGE_COLORS.changed; return <article key={card.name} className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-bg-card px-3 py-2.5" data-comparison-metric={card.name}><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} /><span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{card.name}</span><span className="flex shrink-0 items-center gap-1 text-xs"><b className="rounded bg-blue/10 px-1.5 py-1 text-blue">A&nbsp; {card.left}</b><span className="text-text-muted">→</span><b className="rounded bg-violet-500/10 px-1.5 py-1 text-violet-400">B&nbsp; {card.right}</b><em className="ml-1 rounded-full px-1.5 py-0.5 not-italic font-bold" style={{ color, backgroundColor: `${color}18` }}>{delta(card.delta)}</em></span></article>})}</div> : <p className="rounded-xl border border-dashed border-border bg-bg-card px-4 py-8 text-center text-sm text-text-muted">{t('decks.compareNoCardChanges')}</p>}
      </DeckAnalyticsSection>

      <div className="grid gap-4 lg:grid-cols-2">
        <DeckAnalyticsSection title={t('decks.ownershipValidation')} icon={ShieldCheck}>
          {pairLegend()}
          <DeckPairedBar label={t('decks.missingCopiesCompare')} left={data.ownership.left} right={data.ownership.right} max={Math.max(data.ownership.left, data.ownership.right, 1)} color="#ef4444" leftName={deck.left.name} rightName={deck.right.name} />
          <div className="space-y-2">{(data.validation.changes || []).map(change => <article key={change.code} className="rounded-xl border border-border bg-bg-card p-3"><p className="mb-2 text-sm font-medium text-text-primary">{VALIDATION_KEYS[change.code] ? t(VALIDATION_KEYS[change.code]) : change.code}</p><div className="flex flex-wrap items-center gap-2"><span data-deck-pair="left" className="inline-flex items-center gap-1"><b className="rounded bg-blue/10 px-1.5 py-1 text-[10px] text-blue">A</b><StatusPill check={change.left} t={t} /></span><span className="text-text-muted">→</span><span data-deck-pair="right" className="inline-flex items-center gap-1"><b className="rounded bg-violet-500/10 px-1.5 py-1 text-[10px] text-violet-400">B</b><StatusPill check={change.right} t={t} /></span></div></article>)}</div>
          {(data.validation.changes || []).length === 0 && <p className="text-sm text-text-muted">{t('decks.compareNoValidationChanges')}</p>}
        </DeckAnalyticsSection>

        <DeckAnalyticsSection title={t('decks.effectsConsistency')} icon={Sparkles}>
          {pairLegend()}
          {(data.effects.changes || []).length > 0 ? <div className="space-y-3">{(data.effects.changes || []).map((row, index) => <DeckPairedBar key={row.metric} label={EFFECT_KEYS[row.metric] ? t(EFFECT_KEYS[row.metric]) : row.metric} left={row.left} right={row.right} max={effectMax} color={EFFECT_COLORS[index % EFFECT_COLORS.length]} leftName={deck.left.name} rightName={deck.right.name} />)}</div> : <p className="text-sm text-text-muted">{t('decks.compareNoEffectChanges')}</p>}
        </DeckAnalyticsSection>
      </div>

      <DeckAnalyticsSection title={t('decks.probability')} description={t('decks.compareProbabilityHelp')} icon={Target}>
        {pairLegend()}
        <div className="grid gap-3 sm:grid-cols-2"><DeckSideMetricCard side="left" sideLabel={t('decks.deckA')} name={deck.left.name} label={t('decks.basicOpening')} barValue={basicLeft} /><DeckSideMetricCard side="right" sideLabel={t('decks.deckB')} name={deck.right.name} label={t('decks.basicOpening')} barValue={basicRight} /></div>
        <label className="block max-w-md text-sm text-text-secondary">{t('decks.keyCard')}<select aria-label={t('decks.keyCard')} className="select mt-1 w-full" value={keyCard} onChange={event => setKeyCard(event.target.value)}><option value="">{t('decks.none')}</option>{cardNames.map(name => <option key={name}>{name}</option>)}</select></label>
        {keyCard && <div className="grid gap-3 sm:grid-cols-2" data-comparison-metric="key-card"><DeckSideMetricCard side="left" sideLabel={t('decks.deckA')} name={deck.left.name} label={`${keyCard} · ${t('decks.openingSeven')}`} barValue={data.probability.left?.key_card?.opening_probability} detail={`${data.probability.left?.key_card?.copies || 0} ${t('decks.copies')}`} /><DeckSideMetricCard side="right" sideLabel={t('decks.deckB')} name={deck.right.name} label={`${keyCard} · ${t('decks.openingSeven')}`} barValue={data.probability.right?.key_card?.opening_probability} detail={`${data.probability.right?.key_card?.copies || 0} ${t('decks.copies')}`} /></div>}
      </DeckAnalyticsSection>
    </>}
  </div>
}
