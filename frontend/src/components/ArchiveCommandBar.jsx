import {useEffect, useState} from 'react'
import {Dialog, DialogBody, DialogContent, DialogSurface, Input} from '@fluentui/react-components'
import {SearchRegular} from '@fluentui/react-icons'
import {useNavigate} from 'react-router-dom'

export default function ArchiveCommandBar({open, onClose}) {
    const [query, setQuery] = useState('')
    const navigate = useNavigate()

    useEffect(() => {
        if (!open) setQuery('')
    }, [open])

    const submit = (event) => {
        event.preventDefault()
        navigate(`/search${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`)
        onClose()
    }

    return (
        <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
            <DialogSurface aria-label="Search the archive">
                <DialogBody>
                    <DialogContent>
                        <form onSubmit={submit} className="space-y-3">
                            <Input
                                autoFocus
                                contentBefore={<SearchRegular/>}
                                placeholder="Search the archive"
                                value={query}
                                onChange={(_, data) => setQuery(data.value)}
                                size="large"
                            />
                            <p className="text-sm text-text-muted">Find a card, continue an expansion, or open Chase Cards.</p>
                        </form>
                    </DialogContent>
                </DialogBody>
            </DialogSurface>
        </Dialog>
    )
}
