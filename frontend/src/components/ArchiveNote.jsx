import { Card, CardHeader, Text } from '@fluentui/react-components'
import { Link } from 'react-router-dom'

export default function ArchiveNote({ note }) {
  return <Card as="article" className="archive-note"><CardHeader header={<Text weight="semibold">{note.title}</Text>} description="John John" /><Text>{note.body}</Text><Link to={note.href}>Open</Link></Card>
}
