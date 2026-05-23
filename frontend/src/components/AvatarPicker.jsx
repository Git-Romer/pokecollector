import Modal from './ui/Modal'
import { useSettings } from '../contexts/SettingsContext'

const SPRITE_BASE_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated'
const POKEMON_IDS = Array.from({ length: 151 }, (_, index) => index + 1)

export default function AvatarPicker({ isOpen, onClose, onSelect, currentAvatarId, title }) {
  const { t } = useSettings()

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title || t('auth.chooseAvatar')}
      size="xl"
      mobileSheet={false}
      className="bg-bg-card"
    >
      <div className="space-y-4 p-4">
        <div className="max-h-[70vh] overflow-y-auto rounded-2xl border border-border bg-bg-primary p-4">
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {POKEMON_IDS.map((pokemonId) => {
              const isSelected = currentAvatarId === pokemonId

              return (
                <button
                  key={pokemonId}
                  type="button"
                  onClick={() => {
                    onSelect(pokemonId)
                    onClose()
                  }}
                  className={[
                    'flex h-24 w-full items-center justify-center rounded-xl border bg-bg-card p-3 transition-transform duration-150 hover:scale-105',
                    isSelected ? 'border-brand-red ring-2 ring-brand-red/70' : 'border-border hover:border-brand-red/40',
                  ].join(' ')}
                  title={`#${pokemonId}`}
                >
                  <img
                    src={`${SPRITE_BASE_URL}/${pokemonId}.gif`}
                    alt={`Pokemon ${pokemonId}`}
                    className="h-16 w-16 object-contain pixelated"
                    loading="lazy"
                  />
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </Modal>
  )
}
