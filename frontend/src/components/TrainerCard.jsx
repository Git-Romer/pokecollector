// Shows the user's trainer profile like a real Pokemon Trainer Card
// Props: trainerName, totalCards, totalValue, collectedSets, totalSets, weeklyGain, gainLoss
import { useSettings } from '../contexts/SettingsContext'

export default function TrainerCard({
  trainerName = 'TRAINER',
  totalCards = 0,
  totalValue = 0,
  collectedSets = 0,
  totalSets = 0,
  weeklyGain = 0,
  gainLoss = 0,
}) {
  const { formatPrice } = useSettings()
  const completionPct = totalSets > 0 ? Math.round((collectedSets / totalSets) * 100) : 0
  const hpClass = completionPct >= 66 ? 'healthy' : completionPct >= 33 ? 'medium' : 'low'

  return (
    <div className="trainer-card p-0 overflow-hidden">
      {/* Pokeball watermark rings */}
      <div className="pokeball-ring" style={{ width: 300, height: 300, bottom: -120, right: -80 }} />
      <div className="pokeball-ring" style={{ width: 200, height: 200, bottom: -60, right: -20, borderWidth: 14 }} />

      {/* Header bar */}
      <div className="bg-brand-red px-4 py-2 flex items-center justify-between">
        <span className="text-white text-xs font-black tracking-[0.2em] uppercase">Pokémon Trainer</span>
        <span className="text-white/50 text-[10px] tracking-wider">
          ID No. {String(totalCards).padStart(6, '0')}
        </span>
      </div>

      {/* Card body */}
      <div className="p-4">
        <div className="flex gap-4 items-start">
          {/* Avatar placeholder */}
          <div
            className="w-20 h-24 rounded-xl flex-shrink-0 flex items-center justify-center overflow-hidden"
            style={{
              background: 'linear-gradient(135deg, rgba(227,0,11,0.15), rgba(245,200,66,0.08))',
              border: '1px solid rgba(245,200,66,0.25)',
            }}
          >
            <img src="/pokeball.svg" className="w-12 h-12 opacity-50" alt="" />
          </div>

          {/* Stats */}
          <div className="flex-1 min-w-0">
            <p className="text-gold font-black text-xl leading-none tracking-wide mb-0.5 truncate">
              {trainerName.toUpperCase()}
            </p>
            <p className="text-text-muted text-[10px] mb-3 tracking-wider uppercase">Trainer</p>

            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-text-secondary">Karten</span>
                <span className="text-white font-bold">{Number(totalCards).toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-text-secondary">Wert</span>
                <span className="text-gold font-bold">{formatPrice(Number(totalValue))}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-text-secondary">Sets</span>
                <span className="text-white font-bold">{collectedSets}/{totalSets}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Collection HP bar */}
        <div className="mt-4">
          <div className="flex justify-between text-[10px] text-text-muted mb-1.5">
            <span className="uppercase tracking-wider">Fortschritt</span>
            <span className="font-bold">{completionPct}%</span>
          </div>
          <div className="hp-bar-track">
            <div className={`hp-bar-fill ${hpClass}`} style={{ width: `${completionPct}%` }} />
          </div>
        </div>

        {/* Weekly gain / P&L */}
        {(weeklyGain !== 0 || gainLoss !== 0) && (
          <div className="flex gap-4 mt-3 pt-3 border-t border-white/5">
            {weeklyGain !== 0 && (
              <div>
                <p className="text-[10px] text-text-muted uppercase tracking-wider">Diese Woche</p>
                <p className={`text-sm font-bold ${weeklyGain > 0 ? 'text-green' : 'text-brand-red'}`}>
                  {weeklyGain > 0 ? '+' : ''}{weeklyGain} Karten
                </p>
              </div>
            )}
            {gainLoss !== 0 && (
              <div>
                <p className="text-[10px] text-text-muted uppercase tracking-wider">P&amp;L</p>
                <p className={`text-sm font-bold ${gainLoss >= 0 ? 'text-green' : 'text-brand-red'}`}>
                  {gainLoss >= 0 ? '+' : ''}{formatPrice(Number(gainLoss))}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
