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
      size="lg"
      mobileSheet={false}
      className="bg-bg-card sm:w-auto sm:min-w-[24rem]"
    >
      <div className="space-y-4 p-4">
        <div className="max-h-[70vh] overflow-y-auto overflow-x-hidden rounded-2xl border border-border bg-bg-primary p-3">
          <div className="grid grid-cols-[repeat(3,64px)] justify-center gap-3 sm:grid-cols-[repeat(4,64px)]">
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
                    'flex h-16 w-16 items-center justify-center rounded-xl border bg-bg-card transition-transform duration-150 hover:scale-105',
                    isSelected ? 'border-brand-red ring-2 ring-brand-red/70' : 'border-border hover:border-brand-red/40',
                  ].join(' ')}
                  title={`#${pokemonId}`}
                >
                  <img
                    src={`${SPRITE_BASE_URL}/${pokemonId}.gif`}
                    alt={`Pokemon ${pokemonId}`}
                    className="h-12 w-12 object-contain pixelated"
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
