// Helpers for the "add owned set to a binder" flow on the set page.

// Auto-generated name for the collection binder this feature creates for a set.
export function ownedBinderName(setName, setId) {
  return `${setName || setId} (owned)`
}

// Find an existing collection binder that matches the auto-generated name, so a
// repeated "new binder" action reuses it instead of creating a duplicate.
export function findOwnedBinderForSet(binders, name) {
  return (binders || []).find(
    (b) => (b.binder_type || 'collection') === 'collection' && b.name === name,
  ) || null
}
