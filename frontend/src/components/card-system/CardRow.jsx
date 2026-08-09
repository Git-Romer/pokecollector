import CardListItem, { CompactCardIdentity } from '../CardListItem'

export default function CardRow(props) {
  return <CardListItem {...props} />
}

export function CardIdentity(props) {
  return <CompactCardIdentity {...props} />
}
