import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { GitCompare } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { getDeckProbability, getDecks } from '../../api/client'
import { DECK_COMPOSITION_COLORS, DeckAnalyticsSection as Section, DeckCompositionDonut, DeckMetricGrid as MetricGrid, DeckProbabilityBar as ProbabilityBar } from './DeckAnalyticsVisuals'

const count = value => Number(value || 0)
const whole = value => Math.round(Number(value || 0))
const EFFECT_LABELS = {
  draw: 'effects.draw', pokemon_search: 'effects.pokemonSearch', energy_search: 'effects.energySearch', trainer_search: 'effects.trainerSearch', general_search: 'effects.generalSearch', energy_acceleration: 'effects.energyAcceleration', energy_recovery: 'effects.energyRecovery', pokemon_recovery: 'effects.pokemonRecovery', trainer_recovery: 'effects.trainerRecovery', general_recovery: 'effects.generalRecovery', switching: 'effects.switching', gust: 'effects.gust', healing: 'effects.healing', damage_boost: 'effects.damageBoost', damage_reduction: 'effects.damageReduction', bench_damage: 'effects.benchDamage', status_condition: 'effects.statusCondition', discard: 'effects.discard', hand_disruption: 'effects.handDisruption', deck_disruption: 'effects.deckDisruption', evolution_acceleration: 'effects.evolutionAcceleration', prize_manipulation: 'effects.prizeManipulation', retreat_support: 'effects.retreatSupport',
}
const OUT_LABELS = { draw_outs: 'effects.draw', pokemon_search_outs: 'effects.pokemonSearch', energy_access_outs: 'effects.energySearch', switching_outs: 'effects.switching', recovery_outs: 'effects.generalRecovery' }
const BAR_COLORS = ['#ef4444', '#3b82f6', '#eab308', '#22c55e', '#8b5cf6', '#06b6d4']
const STAGE_COLORS = { Basic: '#22c55e', 'Stage 1': '#3b82f6', 'Stage 2': '#8b5cf6', other_unknown: '#64748b' }
const TYPE_COLORS = {
  Grass: '#65a30d', Fire: '#f97316', Water: '#3b82f6', Lightning: '#eab308', Psychic: '#db2777',
  Fighting: '#dc2626', Darkness: '#7c3aed', Metal: '#64748b', Dragon: '#8b5cf6', Colorless: '#94a3b8', Fairy: '#ec4899',
  other_unknown: '#64748b', unknown: '#64748b',
}
const TRAINER_COLORS = { Item: '#0ea5e9', Supporter: '#8b5cf6', Stadium: '#22c55e', Tool: '#f59e0b', other_unknown: '#64748b' }
const ATTACK_KIND_COLORS = { fixed: '#ef4444', variable: '#f59e0b', non_damage: '#3b82f6', unknown: '#64748b' }
const ATTACK_COST_COLORS = { 0: '#94a3b8', 1: '#22c55e', 2: '#3b82f6', 3: '#8b5cf6', '4+': '#ef4444', unknown: '#64748b' }
const EFFECT_COLORS = { draw: '#3b82f6', pokemon_search: '#ef4444', energy_search: '#eab308', switching: '#8b5cf6', general_recovery: '#22c55e' }
const TYPE_ALIASES = {
  grass: 'Grass', pflanze: 'Grass', plante: 'Grass', planta: 'Grass', erba: 'Grass', grama: 'Grass', gras: 'Grass',
  fire: 'Fire', feuer: 'Fire', feu: 'Fire', fuego: 'Fire', fuoco: 'Fire', fogo: 'Fire', vuur: 'Fire',
  water: 'Water', wasser: 'Water', eau: 'Water', agua: 'Water', acqua: 'Water',
  lightning: 'Lightning', electric: 'Lightning', elektro: 'Lightning', electrique: 'Lightning', electrico: 'Lightning', elettrico: 'Lightning', eletrico: 'Lightning', bliksem: 'Lightning',
  psychic: 'Psychic', psycho: 'Psychic', psy: 'Psychic', psiquico: 'Psychic', psichico: 'Psychic', psychisch: 'Psychic',
  fighting: 'Fighting', kampf: 'Fighting', combat: 'Fighting', lucha: 'Fighting', lotta: 'Fighting', luta: 'Fighting', vechten: 'Fighting',
  darkness: 'Darkness', dark: 'Darkness', finsternis: 'Darkness', unlicht: 'Darkness', obscurite: 'Darkness', oscuridad: 'Darkness', oscurita: 'Darkness', escuridao: 'Darkness', duisternis: 'Darkness',
  metal: 'Metal', metall: 'Metal', metallo: 'Metal', metaal: 'Metal', steel: 'Metal',
  dragon: 'Dragon', drache: 'Dragon', drago: 'Dragon', dragao: 'Dragon', draak: 'Dragon',
  colorless: 'Colorless', colourless: 'Colorless', farblos: 'Colorless', incolore: 'Colorless', incoloro: 'Colorless', incolor: 'Colorless', kleurloos: 'Colorless', normal: 'Colorless',
  fairy: 'Fairy', fee: 'Fairy', hada: 'Fairy', fata: 'Fairy', fada: 'Fairy',
}
const ANALYTICS_LABELS = {
  other_unknown: 'decks.analyticsOtherUnknown',
  unknown: 'decks.analyticsUnknown',
  Basic: 'decks.analyticsStageBasic',
  'Stage 1': 'decks.analyticsStageOne',
  'Stage 2': 'decks.analyticsStageTwo',
  Item: 'decks.analyticsTrainerItem',
  Supporter: 'decks.analyticsTrainerSupporter',
  Stadium: 'decks.analyticsTrainerStadium',
  Tool: 'decks.analyticsTrainerTool',
  Grass: 'decks.analyticsTypeGrass',
  Fire: 'decks.analyticsTypeFire',
  Water: 'decks.analyticsTypeWater',
  Lightning: 'decks.analyticsTypeLightning',
  Psychic: 'decks.analyticsTypePsychic',
  Fighting: 'decks.analyticsTypeFighting',
  Darkness: 'decks.analyticsTypeDarkness',
  Metal: 'decks.analyticsTypeMetal',
  Dragon: 'decks.analyticsTypeDragon',
  Colorless: 'decks.analyticsTypeColorless',
  Fairy: 'decks.analyticsTypeFairy',
}
const ATTACK_KIND_LABELS = {
  fixed: 'decks.analyticsFixedAttacks',
  variable: 'decks.analyticsVariableAttacks',
  non_damage: 'decks.analyticsNonDamageAttacks',
  unknown: 'decks.analyticsUnknownAttacks',
}
const ATTACK_COST_LABELS = {
  0: 'decks.analyticsEnergyCostZero',
  1: 'decks.analyticsEnergyCostOne',
  2: 'decks.analyticsEnergyCostTwo',
  3: 'decks.analyticsEnergyCostThree',
  '4+': 'decks.analyticsEnergyCostFourPlus',
  unknown: 'decks.analyticsUnknownCost',
}

const normalizeType = value => {
  const key = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
  return TYPE_ALIASES[key] || String(value || '').trim() || 'other_unknown'
}

const percentage = value => `${(Number(value || 0) * 100).toFixed(1)}%`

function DistributionBars({ data, colorOffset = 0, t, labelKeys = ANALYTICS_LABELS, colorMap = {}, normalizeKey }) {
  const totals = new Map()
  Object.entries(data || {}).forEach(([rawName, rawValue]) => {
    const name = normalizeKey ? normalizeKey(rawName) : rawName
    totals.set(name, (totals.get(name) || 0) + Number(rawValue || 0))
  })
  const rows = [...totals.entries()].filter(([, value]) => value > 0)
  const max = Math.max(...rows.map(([, value]) => value), 1)
  if (rows.length === 0) return <p className="text-sm text-text-muted">{t('decks.analyticsNoData')}</p>
  return <div className="space-y-3">{rows.map(([name, value], index) => {
    const color = colorMap[name] || BAR_COLORS[(index + colorOffset) % BAR_COLORS.length]
    return <div key={name} data-analytics-row={name}><div className="mb-1 flex items-center justify-between gap-3 text-xs"><span className="flex min-w-0 items-center gap-2 text-text-secondary"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} /><span className="truncate">{labelKeys[name] ? t(labelKeys[name]) : name}</span></span><strong className="text-text-primary">{value}</strong></div><div className="h-2 overflow-hidden rounded-full bg-bg-elevated"><div className="h-full rounded-full" data-analytics-color={color} style={{ width: `${(value / max) * 100}%`, backgroundColor: color }} /></div></div>
  })}</div>
}

function CompositionDonut({ composition, diversity, t }) {
  const data = [
    { key: 'Pokemon', name: t('decks.Pokemon'), value: count(composition.pokemon_count), percent: whole(composition.pokemon_percent) },
    { key: 'Trainer', name: t('decks.Trainer'), value: count(composition.trainer_count), percent: whole(composition.trainer_percent) },
    { key: 'Energy', name: t('decks.Energy'), value: count(composition.energy_count), percent: whole(composition.energy_percent) },
    { key: 'Other', name: t('decks.Other'), value: count(composition.other_count), percent: whole(composition.other_percent) },
  ].filter(item => item.value > 0)
  const items = data.map(item => ({ ...item, label: item.name, color: DECK_COMPOSITION_COLORS[item.key] }))

  return <div className="space-y-3"><DeckCompositionDonut items={items} totalLabel={t('decks.analyticsTotalCards')} ariaLabel={t('decks.composition')} /><div className="space-y-3"><h4 className="text-sm font-semibold text-text-primary">{t('decks.analyticsDiversity')}</h4><MetricGrid items={[{ label: t('decks.analyticsTotalCards'), value: diversity.total_cards }, { label: t('decks.analyticsUniquePrintings'), value: diversity.unique_printings }, { label: t('decks.analyticsUniqueNames'), value: diversity.unique_card_names }]} /></div></div>
}

function Coverage({ coverage, t, descriptions = {}, colorMap = {} }) {
  const [expanded, setExpanded] = useState(null)
  const visible = Object.entries(coverage).filter(([, value]) => value.cards > 0)
  const max = Math.max(...visible.map(([, value]) => value.cards), 1)
  if (visible.length === 0) return <p className="rounded-xl border border-dashed border-border bg-bg-card px-4 py-8 text-center text-sm text-text-muted">{t('decks.analyticsNoCoverage')}</p>
  return <div className="space-y-2">{visible.map(([tag, value], index) => {
    const color = colorMap[tag] || BAR_COLORS[index % BAR_COLORS.length]
    return <div key={tag} className="rounded-xl border border-border bg-bg-card p-3"><button type="button" className="w-full text-left" onClick={() => setExpanded(current => current === tag ? null : tag)}><span className="flex items-start justify-between gap-3"><span className="min-w-0"><span className="flex items-center gap-2 font-medium text-text-primary"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />{t(EFFECT_LABELS[tag])}</span>{descriptions[tag] && <span className="mt-1 block text-xs text-text-muted">{t(descriptions[tag])}</span>}</span><span className="shrink-0 text-right text-xs text-text-secondary"><strong className="text-text-primary">{value.cards}</strong> {t('decks.analyticsCopies')}<br />{value.unique_sources} {t('decks.analyticsDistinctCards')}</span></span><span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-bg-elevated"><span className="block h-full rounded-full" style={{ width: `${(value.cards / max) * 100}%`, backgroundColor: color }} /></span></button>{expanded === tag && <div className="mt-3 space-y-1 border-t border-border pt-2">{value.sources.map(source => <p key={source.card_id} className="flex justify-between gap-3 text-sm text-text-secondary"><span>{source.name}</span><strong>×{source.quantity}</strong></p>)}</div>}</div>
  })}</div>
}

function AttackPanel({ attacks, t }) {
  const kinds = {
    fixed: count(attacks.fixed_attack_count),
    variable: count(attacks.variable_attack_count),
    non_damage: count(attacks.non_damage_attack_count),
    unknown: count(attacks.unknown_attack_count) + count(attacks.unparseable_attack_count),
  }
  const total = Object.values(kinds).reduce((sum, value) => sum + value, 0)
  if (total === 0) return <Section title={t('decks.analyticsAttacks')}><p className="text-sm text-text-secondary">{t('decks.analyticsAttacksHelp')}</p><p className="rounded-xl border border-dashed border-border bg-bg-card px-4 py-8 text-center text-sm text-text-muted">{t('decks.analyticsNoAttacks')}</p></Section>
  return <div className="space-y-3"><p className="card text-sm text-text-secondary">{t('decks.analyticsAttacksHelp')}</p><div className="grid gap-3 md:grid-cols-2"><Section title={t('decks.analyticsAttackKinds')}><DistributionBars data={kinds} t={t} labelKeys={ATTACK_KIND_LABELS} colorMap={ATTACK_KIND_COLORS} /><p className="text-xs text-text-muted">{t('decks.analyticsAttackKindsHelp')}</p></Section><Section title={t('decks.analyticsFixedDamage')}><MetricGrid items={[{ label: t('decks.analyticsAverage'), value: attacks.fixed_damage.average ?? '-' }, { label: t('decks.analyticsMin'), value: attacks.fixed_damage.min ?? '-' }, { label: t('decks.analyticsMax'), value: attacks.fixed_damage.max ?? '-' }, { label: t('decks.analyticsFixedAttacks'), value: attacks.fixed_attack_count }]} /><p className="text-xs text-text-muted">{t('decks.analyticsDamageNote')}</p></Section><Section title={t('decks.analyticsAttackCosts')} className="md:col-span-2"><DistributionBars data={attacks.cost_distribution} t={t} labelKeys={ATTACK_COST_LABELS} colorMap={ATTACK_COST_COLORS} /><p className="text-xs text-text-muted">{t('decks.analyticsAttackCostsHelp')}</p></Section></div></div>
}

function ConsistencyPanel({ effects, t }) {
  const functional = effects ? Object.fromEntries([['draw', effects.outs?.draw_outs], ['pokemon_search', effects.outs?.pokemon_search_outs], ['energy_search', effects.outs?.energy_access_outs], ['switching', effects.outs?.switching_outs], ['general_recovery', effects.outs?.recovery_outs]].filter(([, value]) => value)) : {}
  const keyTags = new Set(['draw', 'pokemon_search', 'energy_search', 'general_search', 'switching', 'energy_recovery', 'pokemon_recovery', 'trainer_recovery', 'general_recovery'])
  const detailed = Object.fromEntries(Object.entries(effects?.coverage || {}).filter(([tag]) => !keyTags.has(tag)))
  const allCoverage = effects?.coverage || {}
  const hasRecognizedEffects = [...Object.values(functional), ...Object.values(allCoverage)].some(value => count(value?.cards) > 0)
  if (!hasRecognizedEffects) return <Section title={t('decks.analyticsConsistency')}><p className="text-sm text-text-secondary">{t('decks.analyticsConsistencyHelp')}</p><p className="rounded-xl border border-dashed border-border bg-bg-card px-4 py-8 text-center text-sm text-text-muted">{t('decks.analyticsNoConsistency')}</p></Section>
  const descriptions = { draw: 'decks.analyticsDrawHelp', pokemon_search: 'decks.analyticsPokemonSearchHelp', energy_search: 'decks.analyticsEnergySearchHelp', switching: 'decks.analyticsSwitchingHelp', general_recovery: 'decks.analyticsRecoveryHelp' }
  return <div className="space-y-3"><div className="card space-y-2"><h3 className="font-semibold text-text-primary">{t('decks.analyticsConsistencyMeaning')}</h3><p className="text-sm text-text-secondary">{t('decks.analyticsConsistencyHelp')}</p><p className="text-xs text-text-muted">{t('decks.analyticsConsistencyCountHelp')}</p></div><div className={`grid gap-3 ${Object.values(detailed).some(value => count(value?.cards) > 0) ? 'lg:grid-cols-2' : ''}`}><Section title={t('decks.analyticsKeyTools')}><Coverage coverage={functional} t={t} descriptions={descriptions} colorMap={EFFECT_COLORS} /></Section>{Object.values(detailed).some(value => count(value?.cards) > 0) && <Section title={t('decks.analyticsOtherEffects')}><Coverage coverage={detailed} t={t} /></Section>}</div></div>
}

function Probability({ deckId, entries, t }) {
  const [hand, setHand] = useState(7)
  const [draws, setDraws] = useState(0)
  const [prizeCount, setPrizeCount] = useState(6)
  const [cardName, setCardName] = useState('')
  const names = [...new Set(entries.map(entry => entry.card?.name).filter(Boolean))].sort((left, right) => left.localeCompare(right))
  const { data, isLoading } = useQuery({ queryKey: ['deck-probability', String(deckId), hand, draws, prizeCount, cardName], queryFn: () => getDeckProbability(deckId, { hand, draws, prize_count: prizeCount, card_name: cardName || undefined }).then(response => response.data) })
  if (isLoading || !data) return <div className="skeleton h-64 rounded-xl" />
  const visibleOuts = Object.entries(data.outs).filter(([, value]) => value.count > 0)
  return <div className="space-y-3"><p className="text-xs text-text-muted">{t('decks.analyticsProbabilityNote')}</p><div className="card grid gap-3 sm:grid-cols-4"><label className="text-xs text-text-muted">{t('decks.analyticsOpeningHand')}<input aria-label={t('decks.analyticsOpeningHand')} type="number" min="0" max="250" className="input mt-1" value={hand} onChange={event => setHand(Number(event.target.value))} /></label><label className="text-xs text-text-muted">{t('decks.analyticsExtraDraws')}<input aria-label={t('decks.analyticsExtraDraws')} type="number" min="0" max="250" className="input mt-1" value={draws} onChange={event => setDraws(Number(event.target.value))} /></label><label className="text-xs text-text-muted">{t('decks.analyticsPrizeCount')}<input aria-label={t('decks.analyticsPrizeCount')} type="number" min="0" max="250" className="input mt-1" value={prizeCount} onChange={event => setPrizeCount(Number(event.target.value))} /></label><label className="text-xs text-text-muted">{t('decks.analyticsKeyCard')}<select aria-label={t('decks.analyticsKeyCard')} className="select mt-1" value={cardName} onChange={event => setCardName(event.target.value)}><option value="">{t('decks.analyticsSelectCard')}</option>{names.map(name => <option key={name} value={name}>{name}</option>)}</select></label></div><div className="grid gap-3 lg:grid-cols-2"><Section title={t('decks.analyticsOpeningHand')}><ProbabilityBar label={t('decks.analyticsBasicPokemon')} value={data.basic_pokemon.at_least_one} detail={`${data.basic_pokemon.count} ${t('decks.analyticsCopies')}`} /><ProbabilityBar label={t('decks.analyticsMulliganRisk')} value={data.basic_pokemon.none} detail={`${data.opening_hand_size} ${t('decks.cards')}`} /></Section><Section title={t('decks.analyticsAccessCards')}>{visibleOuts.length > 0 ? <div className="space-y-2">{visibleOuts.map(([key, value]) => <ProbabilityBar key={key} label={t(OUT_LABELS[key])} value={value.opening_probability} detail={`${value.count} ${t('decks.analyticsCopies')}`} />)}</div> : <p className="rounded-xl border border-dashed border-border bg-bg-card px-4 py-8 text-center text-sm text-text-muted">{t('decks.analyticsNoAccessCards')}</p>}</Section>{data.key_card && <Section title={t('decks.analyticsKeyCard')}><ProbabilityBar label={data.key_card.name} value={data.key_card.opening_probability} detail={`${data.key_card.copies} ${t('decks.analyticsCopies')}`} /><ProbabilityBar label={t('decks.analyticsCardsSeen')} value={data.key_card.cards_seen_probability} /></Section>}{data.key_card && <Section title={t('decks.analyticsPrizeRisk')}><ProbabilityBar label={t('decks.analyticsAtLeastOnePrized')} value={data.key_card.prize_risk.at_least_one} /><ProbabilityBar label={t('decks.analyticsAllCopiesPrized')} value={data.key_card.prize_risk.all_copies} detail={`${t('decks.analyticsExpectedPrized')}: ${data.key_card.prize_risk.expected_copies.toFixed(2)}`} /></Section>}</div></div>
}

function ComparisonLauncher({ deckId, t }) {
  const navigate = useNavigate()
  const [otherDeckId, setOtherDeckId] = useState('')
  const { data: decks = [] } = useQuery({
    queryKey: ['decks'],
    queryFn: () => getDecks().then(response => response.data),
  })
  const currentDeck = decks.find(deck => String(deck.id) === String(deckId))
  const candidates = decks.filter(deck => String(deck.id) !== String(deckId))

  useEffect(() => {
    if (otherDeckId && !candidates.some(deck => String(deck.id) === String(otherDeckId))) setOtherDeckId('')
  }, [candidates, otherDeckId])

  return (
    <Section title={t('decks.compare')}>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-end">
        <label className="text-sm text-text-secondary">
          {t('decks.deckA')}
          <div className="input mt-1 flex items-center text-text-primary" aria-label={t('decks.deckA')}>
            {currentDeck?.name || '—'}
          </div>
        </label>
        <GitCompare className="hidden text-text-muted md:mb-3 md:block" size={20} aria-hidden />
        <label className="text-sm text-text-secondary">
          {t('decks.deckB')}
          <select className="select mt-1 w-full" value={otherDeckId} onChange={event => setOtherDeckId(event.target.value)} aria-label={t('decks.deckB')}>
            <option value="">{t('decks.chooseDeck')}</option>
            {candidates.map(deck => <option key={deck.id} value={deck.id}>{deck.name}</option>)}
          </select>
        </label>
      </div>
      {candidates.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-bg-card px-4 py-8 text-center text-sm text-text-muted">{t('decks.chooseDifferentDecks')}</p>
      ) : (
        <div className="flex justify-end border-t border-border pt-3">
          <button
            type="button"
            className="btn-primary"
            disabled={!otherDeckId}
            onClick={() => navigate(`/decks/compare?left=${deckId}&right=${otherDeckId}`)}
          >
            <GitCompare size={16} aria-hidden /> {t('decks.compare')}
          </button>
        </div>
      )}
    </Section>
  )
}

export default function DeckAnalyticsPanel({ analysis, deckId, entries, t }) {
  const [tab, setTab] = useState('overview')
  if (!analysis) return null
  const { composition, pokemon, trainers, energy, attacks, diversity, effects } = analysis
  const tabs = [['overview', t('decks.analyticsOverview')], ['pokemon', t('decks.analyticsPokemon')], ['trainers', t('decks.analyticsTrainersEnergy')], ['attacks', t('decks.analyticsAttacks')], ['consistency', t('decks.analyticsConsistency')], ['probability', t('decks.analyticsProbability')], ['comparison', t('decks.compare')]]
  return <div className="space-y-4"><div className="overflow-x-auto pb-1"><div className="inline-flex min-w-max rounded-xl border border-border bg-bg-card p-1" role="tablist">{tabs.map(([key, title]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${tab === key ? 'bg-brand-red text-white shadow' : 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary'}`} onClick={() => setTab(key)}>{title}</button>)}</div></div>{tab === 'overview' && <Section title={t('decks.analyticsOverview')}><CompositionDonut composition={composition} diversity={diversity} t={t} /></Section>}{tab === 'pokemon' && <div className="grid gap-3 md:grid-cols-2"><Section title={t('decks.analyticsStages')}><DistributionBars data={pokemon.stages} t={t} colorMap={STAGE_COLORS} /></Section><Section title={t('decks.analyticsTypes')}><DistributionBars data={pokemon.types} t={t} colorMap={TYPE_COLORS} normalizeKey={normalizeType} /></Section><Section title={t('decks.analyticsHp')}><MetricGrid items={[{ label: t('decks.analyticsAverage'), value: pokemon.hp.average ?? '-' }, { label: t('decks.analyticsMedian'), value: pokemon.hp.median ?? '-' }, { label: t('decks.analyticsMin'), value: pokemon.hp.min ?? '-' }, { label: t('decks.analyticsMax'), value: pokemon.hp.max ?? '-' }, { label: t('decks.analyticsMissingHp'), value: pokemon.hp.missing_hp }]} /></Section><Section title={t('decks.analyticsRetreat')}><DistributionBars data={pokemon.retreat.distribution} colorOffset={2} t={t} /><div className="border-t border-border pt-3"><MetricGrid items={[{ label: t('decks.analyticsAverage'), value: pokemon.retreat.average ?? '-' }, { label: t('decks.analyticsMissingRetreat'), value: pokemon.retreat.missing_retreat }]} /></div></Section></div>}{tab === 'trainers' && <div className="grid gap-3 md:grid-cols-2"><Section title={t('decks.analyticsTrainers')}><DistributionBars data={trainers} t={t} colorMap={TRAINER_COLORS} /></Section><Section title={t('decks.Energy')}><MetricGrid items={[{ label: t('decks.analyticsBasicEnergy'), value: energy.basic }, { label: t('decks.analyticsSpecialEnergy'), value: energy.special }, { label: t('decks.analyticsOtherUnknown'), value: energy.other_unknown }]} /><div className="border-t border-border pt-3"><DistributionBars data={energy.types} t={t} colorMap={TYPE_COLORS} normalizeKey={normalizeType} /></div></Section></div>}{tab === 'attacks' && <AttackPanel attacks={attacks} t={t} />}{tab === 'consistency' && <ConsistencyPanel effects={effects} t={t} />}{tab === 'probability' && <Probability deckId={deckId} entries={entries} t={t} />}{tab === 'comparison' && <ComparisonLauncher deckId={deckId} t={t} />}</div>
}
