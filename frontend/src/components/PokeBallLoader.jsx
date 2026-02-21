export default function PokeBallLoader({ size = 32, className = '' }) {
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <img
        src="/pokeball.svg"
        alt="Loading..."
        className="pokeball-loader"
        style={{ width: size, height: size, opacity: 0.7 }}
      />
    </div>
  )
}
