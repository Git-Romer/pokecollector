import { AlertCircle } from 'lucide-react'
import { getApiErrorMessage } from '../api/client'
import { ProductSourceLink } from './ProductSourceList'

export function productLinkErrorNotice(error, fallback) {
  const detail = error?.response?.data?.detail
  const productSources = Array.isArray(detail?.product_sources) ? detail.product_sources : []
  if (productSources.length === 0) return null
  return {
    message: getApiErrorMessage(error, fallback),
    productSources,
  }
}

export default function ActionErrorNotice({ message, productSources = [], t }) {
  if (!message) return null

  const activeSources = productSources.filter(source => Number(source?.active_quantity) > 0)

  return (
    <div role="alert" className="space-y-2 rounded-lg border border-brand-red/25 bg-brand-red/5 p-3 text-sm text-text-primary">
      <div className="flex items-start gap-2">
        <AlertCircle size={16} className="mt-0.5 shrink-0 text-brand-red" aria-hidden="true" />
        <p>{message}</p>
      </div>
      {activeSources.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6">
          {activeSources.map((source, index) => (
            <ProductSourceLink
              key={source.product_card_id || `${source.product_id}-${index}`}
              source={source}
              t={t}
              showName
            />
          ))}
        </div>
      )}
    </div>
  )
}
