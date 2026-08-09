import clsx from 'clsx'
import CardDisplay from './CardDisplay'

/** Shared layered-print treatment used by binders and other grouped cards. */
export default function CardStack({
  card,
  image,
  layers = 0,
  layerOffset = 8,
  className = '',
  ...displayProps
}) {
  const visibleLayers = Math.max(0, Math.min(Number(layers) || 0, 2))

  return (
    <div
      className={clsx('relative', className)}
      style={{ marginRight: visibleLayers * layerOffset, marginBottom: visibleLayers * layerOffset }}
    >
      {Array.from({ length: visibleLayers }).map((_, index) => {
        const depth = index + 1
        return (
          <div
            key={depth}
            aria-hidden
            className="absolute inset-0 shadow-sm"
            style={{
              transform: `translate(${depth * layerOffset}px, ${depth * layerOffset}px) rotate(${depth * 2}deg)`,
              zIndex: visibleLayers - index,
            }}
          >
            <CardDisplay
              variant="artwork"
              card={card}
              image={image}
              alt=""
              showStateIndicators={false}
              loading={displayProps.loading}
            />
          </div>
        )
      })}
      <div className="relative z-10">
        <CardDisplay variant="artwork" card={card} image={image} {...displayProps} />
      </div>
    </div>
  )
}
