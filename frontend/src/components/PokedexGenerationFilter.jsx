import clsx from 'clsx'

export const POKEDEX_GENERATIONS = [
  { id: 1, region: 'Kanto', range: '#001–151' },
  { id: 2, region: 'Johto', range: '#152–251' },
  { id: 3, region: 'Hoenn', range: '#252–386' },
  { id: 4, region: 'Sinnoh', range: '#387–493' },
  { id: 5, region: 'Unova', range: '#494–649' },
  { id: 6, region: 'Kalos', range: '#650–721' },
  { id: 7, region: 'Alola', range: '#722–809' },
  { id: 8, region: 'Galar', range: '#810–905' },
  { id: 9, region: 'Paldea', range: '#906–1025' },
]

export default function PokedexGenerationFilter({ generation, onSelectGeneration, t }) {
  const label = t('pokedex.generationFilter')

  return (
    <>
      <label className="block sm:hidden">
        <span className="sr-only">{label}</span>
        <select
          value={generation ?? ''}
          onChange={(event) => {
            const value = event.target.value
            onSelectGeneration(value ? Number(value) : null)
          }}
          className="select w-full"
        >
          <option value="">{t('pokedex.national')}</option>
          {POKEDEX_GENERATIONS.map((item) => (
            <option key={item.id} value={item.id}>
              Gen {item.id} · {item.region} · {item.range}
            </option>
          ))}
        </select>
      </label>

      <div
        className="-mx-1 hidden gap-2 overflow-x-auto px-1 pb-1 sm:flex"
        role="group"
        aria-label={label}
      >
        <button
          type="button"
          onClick={() => onSelectGeneration(null)}
          aria-pressed={!generation}
          className={clsx(
            'shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-bold',
            !generation
              ? 'border-brand-red bg-brand-red/20 text-brand-red'
              : 'border-border text-text-secondary'
          )}
        >
          {t('pokedex.national')}
        </button>
        {POKEDEX_GENERATIONS.map((item) => (
          <button
            type="button"
            key={item.id}
            onClick={() => onSelectGeneration(item.id)}
            aria-pressed={generation === item.id}
            className={clsx(
              'shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-bold',
              generation === item.id
                ? 'border-brand-red bg-brand-red/20 text-brand-red'
                : 'border-border text-text-secondary'
            )}
          >
            Gen {item.id} · {item.region}
          </button>
        ))}
      </div>
    </>
  )
}
