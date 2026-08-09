import { CardStateLegend, CardStateLegendDisclosure } from '../CardStateIndicators'

export default function CardLegend({ collapsible = true, ...props }) {
  if (collapsible) return <CardStateLegendDisclosure {...props} />
  return <CardStateLegend {...props} />
}
