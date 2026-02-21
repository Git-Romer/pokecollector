import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, Check } from 'lucide-react'
import { getSetChecklist, addToCollection } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import clsx from 'clsx'

export default function SetDetail() {
  const { setId } = useParams()
  const navigate = useNavigate()
  const { t } = useSettings()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('all')

  const { data, isLoading, error } = useQuery({
    queryKey: ['set-checklist', setId],
    queryFn: () => getSetChecklist(setId).then(r => r.data),
  })

  const addMutation = useMutation({
    mutationFn: (cardId) => addToCollection({ card_id: cardId, quantity: 1, condition: 'NM' }),
    onSuccess: () => {
      toast.success(t('card.addedToCollection'))
      queryClient.invalidateQueries({ queryKey: ['set-checklist', setId] })
      queryClient.invalidateQueries({ queryKey: ['collection'] })
    },
    onError: () => toast.error(t('card.addFailed')),
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-32 rounded" />
        <div className="skeleton h-24 rounded-xl" />
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
          {[...Array(20)].map((_, i) => <div key={i} className="skeleton aspect-[2.5/3.5] rounded-lg" />)}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="card text-center py-12">
        <p className="text-brand-red">{t('setDetail.loadFailed')} {error.message}</p>
        <button onClick={() => navigate(-1)} className="btn-ghost mt-4 mx-auto">
          <ArrowLeft size={16} /> {t('setDetail.goBack')}
        </button>
      </div>
    )
  }

  const { set, cards = [], owned_count, total_count, progress } = data || {}

  const filteredCards = cards.filter(card => {
    if (filter === 'owned') return card.owned
    if (filter === 'missing') return !card.owned
    return true
  })

  return (
    <div className="space-y-4 pb-2">
      <button onClick={() => navigate('/sets')} className="btn-ghost text-sm py-1.5">
        <ArrowLeft size={14} /> {t('nav.sets')}
      </button>

      {/* Set Header */}
      <div className="card">
        <div className="flex items-start gap-4">
          {set?.images_logo && (
            <img src={set.images_logo} alt={set.name} className="h-12 sm:h-16 object-contain flex-shrink-0 max-w-[120px]" />
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-text-primary truncate">{set?.name}</h1>
            <p className="text-sm text-text-secondary">{set?.series} · {total_count} {t('setDetail.cards')}</p>

            <div className="mt-3">
              <div className="flex justify-between text-sm mb-1">
                <span className="text-text-secondary">
                  {owned_count} / {total_count} {t('setDetail.ownedOf')}
                </span>
                <span className="font-bold text-brand-red">{progress}%</span>
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
            </div>

            <div className="flex gap-4 mt-3 md:hidden">
              <div>
                <p className="text-lg font-bold text-green">{owned_count}</p>
                <p className="text-xs text-text-muted">{t('setDetail.owned')}</p>
              </div>
              <div>
                <p className="text-lg font-bold text-brand-red">{total_count - owned_count}</p>
                <p className="text-xs text-text-muted">{t('setDetail.missing')}</p>
              </div>
            </div>
          </div>

          <div className="text-right hidden md:block flex-shrink-0">
            <div className="flex gap-4">
              <div>
                <p className="text-2xl font-bold text-green">{owned_count}</p>
                <p className="text-xs text-text-muted">{t('setDetail.owned')}</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-brand-red">{total_count - owned_count}</p>
                <p className="text-xs text-text-muted">{t('setDetail.missing')}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2">
        {[
          { key: 'all', label: `${t('setDetail.all')} (${cards.length})` },
          { key: 'owned', label: `${t('setDetail.owned')} (${owned_count})` },
          { key: 'missing', label: `${t('setDetail.missing')} (${total_count - owned_count})` },
        ].map(({ key, label }) => (
          <button key={key} onClick={() => setFilter(key)}
            className={clsx(
              'px-4 py-2 rounded-lg text-sm font-medium transition-all',
              filter === key
                ? 'bg-brand-red/20 text-brand-red border border-brand-red/30'
                : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'
            )}>
            {label}
          </button>
        ))}
      </div>

      {/* Card Grid */}
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
        {filteredCards.map((card) => (
          <div key={card.id}
            className={clsx(
              'relative group rounded-lg overflow-hidden cursor-pointer transition-all duration-200',
              card.owned
                ? 'ring-2 ring-green/50 hover:ring-green'
                : 'opacity-60 hover:opacity-90 ring-1 ring-brand-red/30 hover:ring-brand-red/60'
            )}>
            {card.images_small ? (
              <img src={card.images_small} alt={card.name} className="w-full aspect-[2.5/3.5] object-cover" loading="lazy" />
            ) : (
              <div className="w-full aspect-[2.5/3.5] bg-bg-card flex items-center justify-center text-xs text-text-muted p-1 text-center">
                {card.name}
              </div>
            )}

            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all flex flex-col items-center justify-center gap-1 opacity-0 group-hover:opacity-100">
              <p className="text-white text-xs font-medium text-center px-1 line-clamp-2">{card.name}</p>
              {!card.owned && (
                <button onClick={(e) => { e.stopPropagation(); addMutation.mutate(card.id) }}
                  className="bg-brand-red text-white rounded-full p-1">
                  <Plus size={12} />
                </button>
              )}
            </div>

            {card.owned && (
              <div className="absolute top-0.5 right-0.5 bg-green rounded-full p-0.5">
                <Check size={8} className="text-white" />
              </div>
            )}
            {card.quantity > 1 && (
              <div className="absolute top-0.5 left-0.5 bg-bg-surface/90 rounded text-xs px-1 text-text-primary font-bold">
                {card.quantity}x
              </div>
            )}

            <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-center text-xs text-text-secondary py-0.5">
              #{card.number}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
