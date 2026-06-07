import clsx from 'clsx'
import { useSettings } from '../contexts/SettingsContext'

export default function MoneyInput({
  value,
  onChange,
  className = 'input',
  wrapperClassName = '',
  placeholder = '0.00',
  ...props
}) {
  const { currencySymbol, exchangeRateReady } = useSettings()
  const disabled = props.disabled || !exchangeRateReady

  return (
    <div className={clsx('relative', wrapperClassName)}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-text-muted">
        {currencySymbol}
      </span>
      <input
        {...props}
        type="number"
        min={props.min ?? '0'}
        step={props.step ?? '0.01'}
        inputMode="decimal"
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        disabled={disabled}
        className={clsx(className, 'pl-7')}
      />
    </div>
  )
}
