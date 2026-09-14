import { Minus, Plus } from 'lucide-react'
import Modal from '../ui/Modal'
import {
  binderPickerItemsWithQuantities,
  binderPickerQuantitiesAreValid,
  binderPickerQuantityMaximum,
  clampBinderPickerQuantity,
} from '../../utils/binderQuantity'

export default function CardSelectionQuantityModal({ t, items = [], quantities, onQuantityChange, onClose, onSubmit, isSubmitting = false }) {
  const isValid = binderPickerQuantitiesAreValid(binderPickerItemsWithQuantities(items, quantities))

  return (
    <Modal
      isOpen={items.length > 0}
      onClose={isSubmitting ? undefined : onClose}
      title={`${t('common.add')} · ${t('common.quantity')}`}
      size="lg"
    >
      <div className="space-y-4 p-4 sm:p-5">
        <p className="text-sm text-text-secondary">{items.length} {t('cardSearch.selected')}</p>
        <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
          {items.map(item => {
            const quantity = quantities[item.id] ?? '1'
            const numericQuantity = Number(quantity)
            const maximum = binderPickerQuantityMaximum(item)
            return (
              <div key={item.id} className="flex items-center gap-3 rounded-xl border border-border bg-bg-elevated/40 p-3">
                {item.image ? <img src={item.image} alt="" className="h-16 w-12 flex-shrink-0 rounded object-cover" /> : <div className="h-16 w-12 flex-shrink-0 rounded bg-bg-elevated" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-text-primary">{item.name}</p>
                  {item.subtitle && <p className="truncate text-xs text-text-muted">{item.subtitle}</p>}
                  {item.maxQuantity !== undefined && <p className="mt-1 text-xs font-medium text-blue">{maximum} {t('cardListPicker.available')}</p>}
                </div>
                <div className="flex flex-shrink-0 items-center gap-1">
                  <button type="button" className="btn-ghost px-2" disabled={isSubmitting || !Number.isInteger(numericQuantity) || numericQuantity <= 1} onClick={() => onQuantityChange(item.id, Math.max(1, numericQuantity - 1))} aria-label={`${t('common.quantity')} -`}><Minus size={14} /></button>
                  <input type="number" min="1" max={maximum} inputMode="numeric" className="input w-16 px-2 text-center" value={quantity} disabled={isSubmitting} onChange={event => onQuantityChange(item.id, clampBinderPickerQuantity(event.target.value, item))} aria-label={`${t('common.quantity')}: ${item.name}`} />
                  <button type="button" className="btn-ghost px-2" disabled={isSubmitting || !Number.isInteger(numericQuantity) || numericQuantity >= maximum} onClick={() => onQuantityChange(item.id, Math.min(maximum, numericQuantity + 1))} aria-label={`${t('common.quantity')} +`}><Plus size={14} /></button>
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <button type="button" className="btn-ghost" disabled={isSubmitting} onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn-primary" disabled={!isValid || isSubmitting} onClick={onSubmit}><Plus size={16} /> {isSubmitting ? t('card.adding') : t('common.add')}</button>
        </div>
      </div>
    </Modal>
  )
}
