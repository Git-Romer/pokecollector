export default function PokeBallLoader({size = 32, className = '', label = "John John is waking the archive…"}) {
    const style = {'--john-john-loader-size': `${size}px`}
    return (
        <div className={`john-john-loader ${className}`} role="status" aria-live="polite" style={style}>
            <span className="john-john-loader-mark" aria-hidden="true">∞</span>
            <span className="john-john-loader-label">{label}</span>
        </div>
    )
}
