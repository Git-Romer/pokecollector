import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2, Edit2, BookOpen, Star, Package, Check, X, Library, Heart } from 'lucide-react'
import { getBinders, createBinder, updateBinder, deleteBinder } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import TabNav from '../components/TabNav'
import toast from 'react-hot-toast'

const BINDER_COLORS = [
  '#EF1515', '#3b82f6', '#22c55e', '#eab308', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16',
]

function BinderForm({ initial = {}, onSubmit, onCancel, loading }) {
  const { t } = useSettings()
  const [name, setName] = useState(initial.name || '')
  const [desc, setDesc] = useState(initial.description || '')
  const [color, setColor] = useState(initial.color || '#EF1515')
  const [binderType, setBinderType] = useState(initial.binder_type || 'collection')

  return (
    <div className="space-y-3">
      <input type="text" placeholder={t('binders.binderName')} value={name}
        onChange={(e) => setName(e.target.value)} className="input" autoFocus />
      <input type="text" placeholder={t('binders.description')} value={desc}
        onChange={(e) => setDesc(e.target.value)} className="input" />

      <div>
        <label className="text-xs text-text-muted mb-2 block">{t('binderTypes.typeLabel')}</label>
        <div className="flex gap-2">
          <button type="button" onClick={() => setBinderType('collection')}
            className={`flex-1 py-2.5 px-3 rounded-lg border text-sm font-medium transition-all flex items-center justify-center gap-2 ${
              binderType === 'collection'
                ? 'bg-blue/20 border-blue text-blue'
                : 'bg-bg-card border-border text-text-muted hover:border-text-muted'
            }`}>
            <Package size={16} /> {t('binderTypes.collectionIcon')} {t('binderTypes.collection')}
          </button>
          <button type="button" onClick={() => setBinderType('wishlist')}
            className={`flex-1 py-2.5 px-3 rounded-lg border text-sm font-medium transition-all flex items-center justify-center gap-2 ${
              binderType === 'wishlist'
                ? 'bg-yellow/20 border-yellow text-yellow'
                : 'bg-bg-card border-border text-text-muted hover:border-text-muted'
            }`}>
            <Star size={16} /> {t('binderTypes.wishlistIcon')} {t('binderTypes.wishlist')}
          </button>
        </div>
        <p className="text-xs text-text-muted mt-1.5">
          {binderType === 'collection' ? t('binderTypes.collectionDesc') : t('binderTypes.wishlistDesc')}
        </p>
      </div>

      <div>
        <label className="text-xs text-text-muted mb-2 block">{t('binders.color')}</label>
        <div className="flex gap-2">
          {BINDER_COLORS.map((c) => (
            <button key={c} type="button"
              className={`w-6 h-6 rounded-full border-2 transition-all ${
                color === c ? 'border-white scale-110' : 'border-transparent hover:scale-110'
              }`}
              style={{ backgroundColor: c }}
              onClick={() => setColor(c)} />
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={() => onSubmit({ name, description: desc, color, binder_type: binderType })}
          disabled={!name || loading} className="btn-primary flex-1">
          <Check size={14} /> {loading ? t('common.saving') : t('common.save')}
        </button>
        <button onClick={onCancel} className="btn-ghost">
          <X size={14} /> {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

export default function Binders() {
  const navigate = useNavigate()
  const { t } = useSettings()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const COLLECTION_TABS = [
    { to: '/collection', label: t('nav.collection'), icon: Library },
    { to: '/binders', label: t('nav.binders'), icon: BookOpen },
    { to: '/wishlist', label: t('nav.wishlist'), icon: Heart },
  ]

  const { data: binders = [], isLoading } = useQuery({
    queryKey: ['binders'],
    queryFn: () => getBinders().then(r => r.data),
  })

  const createMutation = useMutation({
    mutationFn: createBinder,
    onSuccess: () => {
      toast.success(t('binders.created'))
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      setCreating(false)
    },
    onError: () => toast.error(t('binders.createFailed')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateBinder(id, data),
    onSuccess: () => {
      toast.success(t('binders.updated'))
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      setEditingId(null)
    },
    onError: () => toast.error(t('binders.updateFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteBinder,
    onSuccess: () => {
      toast.success(t('binders.deleted'))
      queryClient.invalidateQueries({ queryKey: ['binders'] })
    },
  })

  return (
    <div className="space-y-4 pb-2">
      <TabNav tabs={COLLECTION_TABS} />
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-text-primary">{t('binders.title')}</h1>
          <p className="text-sm text-text-secondary mt-1">{t('binders.subtitle')}</p>
        </div>
        <button onClick={() => setCreating(true)} className="btn-primary">
          <Plus size={16} /> {t('binders.newBinder')}
        </button>
      </div>

      {creating && (
        <div className="card border-brand-red/30">
          <h3 className="text-base font-semibold text-text-primary mb-4">{t('binders.createBinder')}</h3>
          <BinderForm onSubmit={(data) => createMutation.mutate(data)} onCancel={() => setCreating(false)} loading={createMutation.isPending} />
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <div key={i} className="skeleton h-40 rounded-xl" />)}
        </div>
      ) : binders.length === 0 && !creating ? (
        <div className="card text-center py-20">
          <BookOpen size={48} className="mx-auto mb-4 text-text-muted" />
          <p className="text-text-muted">{t('binders.empty')}</p>
          <p className="text-xs text-text-muted mt-1">{t('binders.emptyHint')}</p>
          <button onClick={() => setCreating(true)} className="btn-primary mt-4 mx-auto w-fit">
            <Plus size={16} /> {t('binders.createFirst')}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {binders.map((binder) => {
            const isWishlist = binder.binder_type === 'wishlist'
            return (
              <div key={binder.id}>
                {editingId === binder.id ? (
                  <div className="card">
                    <BinderForm initial={binder}
                      onSubmit={(data) => updateMutation.mutate({ id: binder.id, data })}
                      onCancel={() => setEditingId(null)} loading={updateMutation.isPending} />
                  </div>
                ) : (
                  <div className="card cursor-pointer hover:border-opacity-50 group relative"
                    style={{ borderColor: `${binder.color}30` }}
                    onClick={() => navigate(`/binders/${binder.id}`)}>
                    <div className="absolute top-0 left-0 right-0 h-1 rounded-t-xl" style={{ backgroundColor: binder.color }} />
                    <div className="pt-2">
                      {isWishlist ? (
                        <Star size={32} className="mb-3" style={{ color: binder.color }} />
                      ) : (
                        <BookOpen size={32} className="mb-3" style={{ color: binder.color }} />
                      )}
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-medium text-text-primary">{binder.name}</h3>
                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                          isWishlist ? 'bg-yellow/20 text-yellow' : 'bg-blue/20 text-blue'
                        }`}>
                          {isWishlist ? '⭐' : '📦'}
                        </span>
                      </div>
                      {binder.description && (
                        <p className="text-xs text-text-muted mt-1 line-clamp-2">{binder.description}</p>
                      )}
                      <p className="text-xs text-text-muted mt-1">
                        {isWishlist ? t('binderTypes.wishlist') : t('binderTypes.collection')}
                      </p>
                      <p className="text-sm text-text-secondary mt-2">
                        {binder.card_count} {binder.card_count === 1 ? t('binders.card') : t('binders.cards')}
                      </p>
                    </div>

                    <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={(e) => { e.stopPropagation(); setEditingId(binder.id) }}
                        className="text-text-muted hover:text-text-primary bg-bg/80 rounded p-1 transition-colors">
                        <Edit2 size={12} />
                      </button>
                      <button onClick={(e) => {
                        e.stopPropagation()
                        if (confirm(`${t('binders.deleteConfirm')} "${binder.name}"?`)) deleteMutation.mutate(binder.id)
                      }} className="text-text-muted hover:text-brand-red bg-bg/80 rounded p-1 transition-colors">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
