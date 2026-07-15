import SplitText from '../components/reactbits/SplitText'
import { Button, Input, Text } from '@fluentui/react-components'
import AnimatedCard from '../components/reactbits/AnimatedCard'
import { CameraRegular, HeartRegular, SearchRegular } from '@fluentui/react-icons'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

export default function Discover() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [query, setQuery] = useState(params.get('q') || '')
  const submit = (event) => { event.preventDefault(); navigate(`/card-search?q=${encodeURIComponent(query)}`) }
  return <section className="space-y-6 archive-card-reveal"><header><span className="mag-issue">A LITTLE FURTHER IN</span><h1 className="text-5xl font-bold text-text-primary mag-heading uppercase leading-none mt-2"><SplitText text="Discover" delay={40} /></h1><p className="mt-2 text-text-secondary">Find a card, identify one, or revisit what you’re still looking for.</p></header><form onSubmit={submit}><Input size="large" value={query} onChange={(_, data) => setQuery(data.value)} contentBefore={<SearchRegular />} placeholder="Search cards" /></form><div className="grid gap-4 md:grid-cols-3"><AnimatedCard className="archive-discover-card p-4 flex flex-col items-center text-center gap-2"><SearchRegular fontSize={28} /><Text weight="semibold">Search cards</Text><Button onClick={submit}>Search</Button></AnimatedCard><AnimatedCard className="archive-discover-card p-4 flex flex-col items-center text-center gap-2"><CameraRegular fontSize={28} /><Text weight="semibold">Scan a card</Text><Button onClick={() => navigate('/card-search?scanner=1')}>Open scanner</Button></AnimatedCard><AnimatedCard className="archive-discover-card p-4 flex flex-col items-center text-center gap-2"><HeartRegular fontSize={28} /><Text weight="semibold">Open wishlist</Text><Button onClick={() => navigate('/wishlist')}>Open wishlist</Button></AnimatedCard></div></section>
}
