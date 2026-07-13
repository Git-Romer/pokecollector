import { Button, Card, Input, Text } from '@fluentui/react-components'
import { CameraRegular, HeartRegular, SearchRegular } from '@fluentui/react-icons'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

export default function Discover() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [query, setQuery] = useState(params.get('q') || '')
  const submit = (event) => { event.preventDefault(); navigate(`/card-search?q=${encodeURIComponent(query)}`) }
  return <section className="space-y-6 archive-card-reveal"><header><p className="text-sm text-text-muted">A little further in</p><h1 className="text-3xl font-semibold">Discover</h1><p className="mt-2 text-text-secondary">Find a card, identify one, or revisit what you’re still looking for.</p></header><form onSubmit={submit}><Input size="large" value={query} onChange={(_, data) => setQuery(data.value)} contentBefore={<SearchRegular />} placeholder="Search cards" /></form><div className="grid gap-4 md:grid-cols-3"><Card className="archive-discover-card"><SearchRegular fontSize={28} /><Text weight="semibold">Search cards</Text><Button onClick={submit}>Search</Button></Card><Card className="archive-discover-card"><CameraRegular fontSize={28} /><Text weight="semibold">Scan a card</Text><Button onClick={() => navigate('/card-search?scanner=1')}>Open scanner</Button></Card><Card className="archive-discover-card"><HeartRegular fontSize={28} /><Text weight="semibold">Open wishlist</Text><Button onClick={() => navigate('/wishlist')}>Open wishlist</Button></Card></div></section>
}
