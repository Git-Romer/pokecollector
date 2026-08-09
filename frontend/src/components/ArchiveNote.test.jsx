import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'

test('exposes dismiss and undo as controlled note actions', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, './ArchiveNote.jsx'), 'utf-8')
    expect(source).toContain('onDismiss')
    expect(source).toContain('Dismiss John John note')
    expect(source).toContain('onUndo')
    expect(source).not.toContain('window.location.reload')
})
