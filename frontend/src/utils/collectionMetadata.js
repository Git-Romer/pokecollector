export function defaultPurchasePrice(source) {
  if (source === 'pulled') return 4.49;
  if (source === 'bulk_before_tracking') return 0;
  return null;
}

export const ACQUISITION_SOURCES = [
  { value: 'pulled', label: 'Pulled' },
  { value: 'bulk_before_tracking', label: 'Bulk before tracking' },
  { value: 'purchased', label: 'Purchased' },
  { value: 'trade', label: 'Trade' },
  { value: 'gift', label: 'Gift' },
  { value: 'other', label: 'Other' }
];
