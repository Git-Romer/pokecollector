import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

const projectRoot = resolve(__dirname, '../..')
const read = (path) => readFileSync(resolve(projectRoot, path), 'utf8')

test('John John motion system preserves collector motion while honoring reduced-motion', () => {
    const runtimeSurfaces = [
        'src/design/archive.css',
        'src/hooks/useTheme.js',
        'src/components/reactbits/ASCIIText.jsx',
        'src/pages/Login.jsx',
        'src/components/ArchiveShell.jsx',
        'src/components/JohnJohnSignal.jsx'
    ].map(read).join('\n')

    expect(runtimeSurfaces).not.toMatch(/enableWaves=\{false\}|enableWaves\s*=\s*false/)
    expect(runtimeSurfaces).toContain('archive-route-frame')
    expect(runtimeSurfaces).toContain('john-john-signal')
    expect(runtimeSurfaces).toContain('∞')

    const archiveStyles = read('src/design/archive.css')
    expect(archiveStyles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(archiveStyles).toContain('animation: none !important')
    expect(archiveStyles).toContain('transition: none !important')
})
