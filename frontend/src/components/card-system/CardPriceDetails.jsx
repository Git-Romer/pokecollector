import { useQuery } from '@tanstack/react-query'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ExternalLink } from 'lucide-react'
import { getPriceHistory } from '../../api/client'
import { useSettings } from '../../contexts/SettingsContext'
import { cardmarketLinks } from '../../utils/cardmarket'
import { getCardPriceValue, getPrimaryCardPrice } from '../../utils/prices'

const CARDMARKET_PRICE_KEYS = ['trend', 'avg', 'avg1', 'avg7', 'avg30', 'low']
const CARDMARKET_REVERSE_PRICE_FIELDS = [
  ['trend', 'price_trend_holo'],
  ['avg', 'price_market_holo'],
  ['avg1', 'price_avg1_holo'],
  ['avg7', 'price_avg7_holo'],
  ['avg30', 'price_avg30_holo'],
  ['low', 'price_low_holo'],
]

export function cardmarketPriceBreakdown(card, variant) {
  if (variant === 'Reverse Holo') {
    const reversePrices = CARDMARKET_REVERSE_PRICE_FIELDS
      .map(([key, field]) => card?.[field] != null ? { key, val: card[field] } : null)
      .filter(Boolean)
    if (reversePrices.length > 0) return reversePrices
  }

  return CARDMARKET_PRICE_KEYS
    .map(key => {
      const val = getCardPriceValue(card, key)
      return val != null ? { key, val } : null
    })
    .filter(Boolean)
}

export function tcgplayerPriceBreakdown(card) {
  return [
    card?.price_tcg_normal_market != null ? { key: 'tcg-normal', val: card.price_tcg_normal_market, label: 'Normal' } : null,
    card?.price_tcg_reverse_market != null ? { key: 'tcg-reverse', val: card.price_tcg_reverse_market, label: 'Reverse' } : null,
    card?.price_tcg_holo_market != null ? { key: 'tcg-holo', val: card.price_tcg_holo_market, label: 'Holo' } : null,
  ].filter(Boolean)
}

export default function CardPriceDetails({ card, variant = 'Normal', summary = null }) {
  const { t, formatPrice, formatUsdPrice, pricePrimary, pricePrimaryField } = useSettings()
  const cardIdForHistory = card?.card_id || (typeof card?.id === 'string' ? card.id : null)
  const { data: priceHistory = [] } = useQuery({
    queryKey: ['price-history', cardIdForHistory],
    queryFn: () => getPriceHistory(cardIdForHistory).then(response => response.data),
    enabled: typeof cardIdForHistory === 'string' && cardIdForHistory.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  const safePriceHistory = Array.isArray(priceHistory) ? priceHistory : []
  const marketLinks = cardmarketLinks(card, variant)
  const cardmarketPrices = cardmarketPriceBreakdown(card, variant)
  const tcgplayerPrices = tcgplayerPriceBreakdown(card)
  const selectedPrimaryPrice = getPrimaryCardPrice(card, variant, pricePrimary, pricePrimaryField)
  const historyPriceField = ['price_market', 'price_trend', 'price_low'].includes(pricePrimaryField)
    ? pricePrimaryField
    : 'price_market'
  const historyPriceLabel = pricePrimaryField === historyPriceField
    ? t(`prices.${pricePrimary}`)
    : t('prices.avg')

  return (
    <div className="space-y-4">
      {summary}

      {cardmarketPrices.length > 0 && (
        <div className="bg-bg-card rounded-xl p-3 space-y-3">
          <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
            {t('prices.cardmarketTitle')} · {variant}
          </p>
          {selectedPrimaryPrice != null && (
            <p className="text-2xl font-bold text-green">{formatPrice(selectedPrimaryPrice)}</p>
          )}
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 text-xs border-t border-border pt-2">
            {cardmarketPrices.map(({ key, val }) => (
              <div key={key}>
                <span className="text-text-muted">{t(`prices.${key}`)}</span>
                <p className={key === 'trend' ? 'text-green font-bold' : 'text-text-primary font-bold'}>
                  {formatPrice(val)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {!card?.is_custom && marketLinks.length > 0 && (
        <div className="bg-bg-card rounded-xl p-3 space-y-2 border border-border">
          <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
            {t('cardmarket.buy')}
          </p>
          <div className="flex flex-wrap gap-2">
            {marketLinks.map(link => (
              <a
                key={link.productId || link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-ghost text-xs inline-flex items-center gap-1.5"
              >
                <ExternalLink size={14} />
                {link.fallback
                  ? t('cardmarket.search')
                  : link.label || t('cardmarket.openProduct')}
              </a>
            ))}
          </div>
          {marketLinks.some(link => link.fallback) && (
            <p className="text-[10px] text-text-muted">{t('cardmarket.searchFallback')}</p>
          )}
        </div>
      )}

      {tcgplayerPrices.length > 0 && (
        <div className="bg-bg-card rounded-xl p-3 space-y-2">
          <p className="text-xs text-text-muted font-medium uppercase tracking-wide">TCGPlayer</p>
          <div className="grid grid-cols-3 gap-2 text-xs">
            {tcgplayerPrices.map(({ key, val, label }) => (
              <div key={key}>
                <span className="text-text-muted block">{label}</span>
                <span className="font-bold text-blue-400">{formatUsdPrice(val)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {safePriceHistory.length > 0 && (
        <div className="bg-bg-card rounded-xl p-3 space-y-2">
          <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
            {t('prices.history')}
          </p>
          <div className="h-[140px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={safePriceHistory} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: '#606078' }}
                  tickFormatter={date => { try { return new Date(date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) } catch { return '' } }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={30}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#606078' }}
                  tickFormatter={value => { try { return formatPrice(Number(value)) } catch { return '' } }}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  contentStyle={{
                    background: 'rgba(20,20,34,0.95)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '0.75rem',
                    fontSize: '0.75rem',
                  }}
                  labelFormatter={date => new Date(date).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })}
                  formatter={value => { try { return [formatPrice(Number(value)), historyPriceLabel] } catch { return ['', ''] } }}
                />
                <Area
                  type="monotone"
                  dataKey={historyPriceField}
                  stroke="#22c55e"
                  fill="url(#priceGrad)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 3, fill: '#22c55e', stroke: 'none' }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {(() => {
            const first = safePriceHistory[0]?.[historyPriceField]
            const last = safePriceHistory[safePriceHistory.length - 1]?.[historyPriceField]
            if (first && last && first > 0) {
              const change = ((last - first) / first) * 100
              return (
                <p className={`text-xs font-semibold ${change >= 0 ? 'text-green' : 'text-brand-red'}`}>
                  {change >= 0 ? '↑' : '↓'} {Math.abs(change).toFixed(1)}% {t('prices.sinceTracking')}
                </p>
              )
            }
            return null
          })()}
        </div>
      )}
    </div>
  )
}
