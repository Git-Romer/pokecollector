export function SectionHeader({ title }) {
  return (
    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-text-muted px-1 mb-3">
      {title}
    </p>
  )
}

export function SettingsCard({ children }) {
  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.07)',
      }}
    >
      {children}
    </div>
  )
}

export function SettingsRow({ label, description, children, last }) {
  return (
    <div
      className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4 px-4 py-3.5"
      style={!last ? { borderBottom: '1px solid rgba(255,255,255,0.05)' } : {}}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-text-primary">{label}</p>
        {description && (
          <p className="text-xs text-text-muted mt-0.5" style={{overflowWrap:"anywhere"}}>{description}</p>
        )}
      </div>
      <div className="flex-shrink-0 w-full sm:w-auto">{children}</div>
    </div>
  )
}

export function Toggle({ value, onChange, label, disabled = false }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      disabled={disabled}
      className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
        value ? 'bg-brand-red' : 'bg-bg-elevated border border-border'
      } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      aria-pressed={value}
      aria-label={label}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
          value ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

export function SelectControl({ value, options, onChange, disabled = false, label }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={`select w-full max-w-full sm:w-auto text-xs font-semibold ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}
