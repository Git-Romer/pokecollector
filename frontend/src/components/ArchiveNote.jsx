import {CardHeader, Text} from '@fluentui/react-components'
import {Link} from 'react-router-dom'
import {ArrowRightRegular} from '@fluentui/react-icons'
import AnimatedCard from './reactbits/AnimatedCard'
import SplitText from './reactbits/SplitText'

export default function ArchiveNote({note}) {
    return (
        <AnimatedCard className="archive-note p-4 flex flex-col gap-2">
            <CardHeader
                header={<Text weight="semibold"><SplitText text={note.title} delay={60}/></Text>}
                description="John John"
            />
            <Text>{note.body}</Text>
            <footer className="mt-4 flex gap-4 text-sm font-semibold">
                {note.href && (
                    <Link to={note.href}
                          className="inline-flex items-center gap-2 text-text-primary hover:text-jj-lightblue transition-colors">
                        <ArrowRightRegular/> Take me there
                    </Link>
                )}
                {note.undo_action_id && (
                    <button
                        onClick={() => fetch(`/api/agent/undo/${note.undo_action_id}`, {method: 'POST'}).then(() => window.location.reload())}
                        className="inline-flex items-center gap-2 text-jj-red hover:text-white transition-colors">
                        <ArrowRightRegular/> Undo Action
                    </button>
                )}
            </footer>
        </AnimatedCard>
    )
}
