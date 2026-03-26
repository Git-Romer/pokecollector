import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { getUserCollection } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { CardModal } from '../components/CardItem'

export default function UserCollection() {
  const { userId } = useParams()
  const navigate = useNavigate()
  const { t, formatPrice } = useSettings()
  const [selectedCard, setSelectedCard] = useState(null)

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['user-collection', userId],
    queryFn: () => getUserCollection(userId),
  })

  const totalValue = items.reduce((sum, item) => {
    const price = item.card?.price_market || 0
    return sum + price * item.quantity
  }, 0)

  return (
    <div className="page-container">
      <div className="card">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="text-text-muted hover:text-text-primary">
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-xl font-bold text-text-primary">{t('collection.userCollection')}</h1>
            <p className="text-sm text-text-secondary">
              {items.length} {t('collection.cards')} · {formatPrice(totalValue)}
            </p>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
          {[...Array(12)].map((_, i) => <div key={i} className="skeleton aspect-[2.5/3.5] rounded-xl" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="card text-center py-12 text-text-muted">{t('collection.empty')}</div>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
          {items.map((item) => {
            const card = item.card
            if (!card) return null
            const imgSrc = card.images_small || resolveCardImageUrl(card) || (card.image ? `${card.image}/low.webp` : null)
            return (
              <div
                key={item.id}
                className="cursor-pointer group"
                onClick={() => setSelectedCard(card)}
              >
                <div className="aspect-[2.5/3.5] rounded-xl overflow-hidden ring-1 ring-white/5 group-hover:ring-brand-red/30 transition-all">
                  {imgSrc ? (
                    <img src={imgSrc} alt={card.name} className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-full bg-bg-surface flex items-center justify-center text-[9px] text-text-muted p-1 text-center">
                      {card.name}
                    </div>
                  )}
                </div>
                <div className="mt-1 px-0.5">
                  <p className="text-[10px] font-semibold text-text-primary truncate">{card.name}</p>
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-text-muted">{item.quantity}x · {item.variant || 'Normal'}</span>
                    {card.price_market && (
                      <span className="text-[9px] font-bold text-green">{formatPrice(card.price_market)}</span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {selectedCard && (
        <CardModal
          card={selectedCard}
          onClose={() => setSelectedCard(null)}
        />
      )}
    </div>
  )
}
