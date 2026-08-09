import {CardHeader, Text} from '@fluentui/react-components'
import {Link} from 'react-router-dom'
import {ArrowRightRegular} from '@fluentui/react-icons'
import AnimatedCard from './reactbits/AnimatedCard'
import SplitText from './reactbits/SplitText'

export default function ArchiveNote({note, onDismiss, onUndo, isDismissing = false}) {
    return (
        <AnimatedCard className="archive-note p-4 flex flex-col gap-2">
            <CardHeader
                header={<Text weight="semibold"><SplitText text={note.title} delay={60}/></Text>}
                description="John John"
                action={onDismiss ? (
                    <button
                        type="button"
                        className="btn-ghost py-1 px-2 text-xs"
                        onClick={() => onDismiss(note.id)}
                        disabled={isDismissing}
                        aria-label={`Dismiss John John note: ${note.title}`}
                    >
                        {isDismissing ? 'Dismissing…' : 'Dismiss'}
                    </button>
                ) : null}
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
                        type="button"
                        onClick={() => onUndo ? onUndo(note.undo_action_id) : undefined}
                        disabled={!onUndo}
                        className="inline-flex items-center gap-2 text-jj-red hover:text-white transition-colors disabled:opacity-50">
                        <ArrowRightRegular/> Undo Action
                    </button>
                )}
            </footer>
        </AnimatedCard>
    )
}
