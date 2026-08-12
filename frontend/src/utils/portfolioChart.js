import { format, parseISO } from 'date-fns'

export const PORTFOLIO_PERIODS = [
  { key: '1W', label: '1W', apiPeriod: '1w' },
  { key: '1M', label: '1M', apiPeriod: '1m' },
  { key: '1Y', label: '1Y', apiPeriod: '1y' },
  { key: 'MAX', label: 'Max', apiPeriod: 'max' },
]

export const portfolioApiPeriod = (period) => (
  PORTFOLIO_PERIODS.find(option => option.key === period)?.apiPeriod || 'max'
)

export function mapPortfolioChartData(data, period, legacyLabel) {
  const formatByPeriod = { '1W': 'EEE dd.MM', '1Y': 'MMM yy', 'MAX': 'MMM yy' }
  const dateFormat = formatByPeriod[period] || 'dd.MM.'

  return (data || []).map(snapshot => {
    const snapshotDate = parseISO(snapshot.date)
    return {
      ...snapshot,
      date: format(snapshotDate, dateFormat),
      tooltipLabel: period === '1W'
        ? format(snapshotDate, 'EEE dd.MM HH:mm')
        : format(snapshotDate, dateFormat),
      legacy: Boolean(snapshot.legacy),
      legacyLabel,
    }
  })
}
