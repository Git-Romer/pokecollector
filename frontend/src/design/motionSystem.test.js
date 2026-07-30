import {execFile} from 'node:child_process'
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {promisify} from 'node:util'

const projectRoot = resolve(__dirname, '../..')
const read = (path) => readFileSync(resolve(projectRoot, path), 'utf8')
const run = promisify(execFile)

const findBuiltCss = (directory) => readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return findBuiltCss(path)
    return entry.name.endsWith('.css') ? [path] : []
})

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

test('production build preserves the reduced-motion media rule', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'john-john-motion-build-'))
    const viteCli = resolve(projectRoot, 'node_modules/vite/bin/vite.js')

    try {
        await run(process.execPath, [viteCli, 'build', '--configLoader', 'runner', '--outDir', outputDir], {
            cwd: projectRoot
        })

        const builtCss = findBuiltCss(outputDir).map((path) => readFileSync(path, 'utf8')).join('\n')
        expect(builtCss).toContain('prefers-reduced-motion')
        expect(builtCss).toContain('animation:none!important')
        expect(builtCss).toContain('transition:none!important')
    } finally {
        rmSync(outputDir, {recursive: true, force: true})
    }
}, 30_000)
