import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, './ExcelImportModal.jsx'), 'utf-8')

describe('Excel import first-release language', () => {
    it('explains legacy purchase_price as Cost Basis in the CSV workflow', () => {
        expect(source).toContain('treat it as Cost Basis')
        expect(source).toContain('Leave it blank when cost basis is needed')
        expect(source).toContain('purchase_price')
    })
})
