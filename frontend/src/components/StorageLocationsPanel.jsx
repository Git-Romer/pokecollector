import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, MapPin, Plus, Power } from 'lucide-react'
import toast from 'react-hot-toast'

import {
  createStorageLocation,
  getApiErrorMessage,
  getStorageLocations,
  updateStorageLocation,
} from '../api/client'

export default function StorageLocationsPanel() {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const { data: locations = [], isLoading } = useQuery({
    queryKey: ['storage-locations', 'all'],
    queryFn: () => getStorageLocations({ include_inactive: true }),
  })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['storage-locations'] })
  }

  const createMutation = useMutation({
    mutationFn: () => createStorageLocation({
      name: name.trim(),
      description: description.trim() || null,
    }),
    onSuccess: location => {
      setName('')
      setDescription('')
      refresh()
      toast.success(`${location.name} is ready`)
    },
    onError: error => toast.error(getApiErrorMessage(error, 'Could not add the storage location')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateStorageLocation(id, data),
    onSuccess: refresh,
    onError: error => toast.error(getApiErrorMessage(error, 'Could not update the storage location')),
  })

  return (
    <div className="storage-settings-panel">
      <div className="storage-settings-intro">
        <span className="storage-settings-icon"><MapPin size={18} /></span>
        <div>
          <h3>Storage locations</h3>
          <p>Reusable homes for cards, slabs, and sealed product. “To organize” stays available for new intake.</p>
        </div>
      </div>

      <div className="storage-location-list">
        {isLoading && <div className="archive-loading"><span className="archive-loading-orbit" /> Loading locations…</div>}
        {locations.map(location => (
          <div key={location.id} className={`storage-location-row ${!location.is_active ? 'storage-location-row-inactive' : ''}`}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{location.name}</strong>
                {location.is_default && <span className="storage-default-badge"><Check size={11} /> Default</span>}
                {!location.is_active && <span className="storage-inactive-badge">Inactive</span>}
              </div>
              {location.description && <p>{location.description}</p>}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {!location.is_default && location.is_active && (
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={() => updateMutation.mutate({ id: location.id, data: { is_default: true } })}
                >
                  Make default
                </button>
              )}
              {!location.is_default && (
                <button
                  type="button"
                  className="btn-ghost px-2"
                  title={location.is_active ? 'Deactivate' : 'Reactivate'}
                  aria-label={location.is_active ? `Deactivate ${location.name}` : `Reactivate ${location.name}`}
                  onClick={() => updateMutation.mutate({
                    id: location.id,
                    data: { is_active: !location.is_active },
                  })}
                >
                  <Power size={14} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <form
        className="storage-location-create"
        onSubmit={event => {
          event.preventDefault()
          if (name.trim()) createMutation.mutate()
        }}
      >
        <input className="input" value={name} onChange={event => setName(event.target.value)} placeholder="New location name" required />
        <input className="input" value={description} onChange={event => setDescription(event.target.value)} placeholder="Optional description" />
        <button className="btn-primary justify-center" disabled={!name.trim() || createMutation.isPending}>
          <Plus size={15} /> Add location
        </button>
      </form>
    </div>
  )
}
