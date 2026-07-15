import SplitText from '../components/reactbits/SplitText'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Dialog, DialogBody, DialogContent, DialogSurface, Field, Input, Spinner, Text } from '@fluentui/react-components'
import AnimatedCard from '../components/reactbits/AnimatedCard'
import { AddRegular, BoxRegular } from '@fluentui/react-icons'
import { Link } from 'react-router-dom'
import { createBinder, getBinders } from '../api/client'

export default function Boxes() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const client = useQueryClient()
  const { data: boxes = [], isLoading } = useQuery({ queryKey: ['binders'], queryFn: () => getBinders().then((r) => r.data) })
  const create = useMutation({ mutationFn: (nextName) => createBinder({ name: nextName, description: '', binder_type: 'collection', color: '#5b9cff' }), onSuccess: () => { client.invalidateQueries({ queryKey: ['binders'] }); setName(''); setOpen(false) } })
  return <section className="space-y-6 archive-card-reveal"><header className="flex items-end justify-between gap-4"><div><span className="mag-issue">STORAGE ROOM</span><h1 className="text-5xl font-bold text-text-primary mag-heading uppercase leading-none mt-2"><SplitText text="Boxes" delay={40} /></h1><p className="mt-2 text-text-secondary">A calm place for the parts of your collection that belong together.</p></div><Button appearance="primary" icon={<AddRegular />} onClick={() => setOpen(true)}>New Box</Button></header>{isLoading ? <Spinner label="Opening boxes" /> : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{boxes.map((box) => <Link key={box.id} to={`/boxes/${box.id}`}><AnimatedCard className="archive-box p-4 flex flex-col gap-2"><BoxRegular fontSize={32} /><Text weight="semibold" size={500}>{box.name}</Text><Text size={200}>{box.description || 'Ready for cards.'}</Text></AnimatedCard></Link>)}</div>}<Dialog open={open} onOpenChange={(_, data) => setOpen(data.open)}><DialogSurface><DialogBody><DialogContent><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (name.trim()) create.mutate(name.trim()) }}><Field label="Box name"><Input autoFocus value={name} onChange={(_, data) => setName(data.value)} /></Field><Button type="submit" appearance="primary" disabled={!name.trim() || create.isPending}>Create Box</Button></form></DialogContent></DialogBody></DialogSurface></Dialog></section>
}
