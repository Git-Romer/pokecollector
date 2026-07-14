# John John's PC Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine the local tracker into a collection-first John John's PC with John John as an ambient local-only presence, structured care data, and Excel export.

**Architecture:** Preserve the existing FastAPI routes, SQLite migration pattern, React Router paths, collection rows, and product records. Add optional collection metadata, use the existing product model for sealed inventory, and expose those concerns through focused frontend components.

**Tech Stack:** React 18, Vite, Vitest, Fluent UI v9, Tailwind CSS, FastAPI, SQLAlchemy, Pydantic, openpyxl, pytest.

## Global Constraints

- Visible product name is exactly `John John's PC`.
- Primary navigation remains Collection, Card Search, Sets, Analytics, and Settings.
- Preserve database records, API paths, legacy routes, and `docker-compose.local.yml`.
- Collection Overview has no portfolio, P&L, or market hero metric.
- John John is a local faceless JJ signal, never a chatbot, avatar, or external AI integration.
- Use black, warm-white, and orange for chrome; reserve the spectrum for John John.
- Use Inter, accessible dark/light themes, and reduced-motion support.
- Imports never automatically overwrite collection data; no credentials or live integrations are added.
- Every behavior change starts with a failing focused test.

---

### Task 1: Establish tracker identity and Collection Overview language

**Files:**
- Modify: `frontend/index.html`, `frontend/public/manifest.json`, `frontend/src/components/ArchiveShell.jsx`, `frontend/src/components/JohnJohnSignal.jsx`, `frontend/src/pages/Archive.jsx`, `frontend/src/design/archiveTheme.js`, `frontend/src/design/archive.css`, `frontend/src/hooks/useTheme.js`
- Modify: `frontend/src/components/ArchiveShell.test.jsx`
- Create: `frontend/src/pages/Archive.test.jsx`

**Interfaces:** The wordmark links to `/` as John John's PC. The root renders Collection Overview and John John’s Notes. The fixed five destination labels and routes remain unchanged.

- [ ] **Step 1: Write the failing shell identity test.**

```jsx
test('uses the tracker wordmark and familiar destinations', () => {
  render(<MemoryRouter><ArchiveShell /></MemoryRouter>)
  expect(screen.getAllByText("John John's PC")[0]).toBeVisible()
  expect(screen.getByRole('link', { name: 'Collection' })).toBeVisible()
  expect(screen.getByRole('link', { name: 'Settings' })).toBeVisible()
})
```

- [ ] **Step 2: Run `npm --prefix frontend test -- ArchiveShell.test.jsx`.**
Expected: FAIL because the current wordmark is John John's PC.

- [ ] **Step 3: Implement the minimal identity/token changes.**
Set browser and PWA titles to John John's PC. Make the wordmark a `NavLink` to `/`; change passive signal copy to “John John is keeping watch.” Replace navy tokens with black canvas `#000000`, warm surface `#171513`, warm-white text `#FFFFFF`, and orange `#F58220`; retain contrast-safe light tokens and reduced-motion rules. Change the primary font stack to `Inter, system-ui, sans-serif`.

- [ ] **Step 4: Write the failing root-copy test.**

```jsx
test('calls the root Collection Overview without market copy', async () => {
  render(<Archive />)
  expect(await screen.findByRole('heading', { name: 'Collection Overview' })).toBeVisible()
  expect(screen.queryByText(/portfolio|P&L|market/i)).not.toBeInTheDocument()
})
```

- [ ] **Step 5: Run `npm --prefix frontend test -- Archive.test.jsx`, then implement the minimum change.**
Expected: FAIL because the page still renders Your Archive. Replace root-page Archive language with Collection Overview and Archive notes with John John’s Notes. Preserve existing dashboard/set queries, feature/recent/set-progress ordering, and CSS-only motion.

- [ ] **Step 6: Verify and commit.**

```bash
npm --prefix frontend test -- ArchiveShell.test.jsx Archive.test.jsx
npm --prefix frontend run build
git add frontend/index.html frontend/public/manifest.json frontend/src/components/ArchiveShell.jsx frontend/src/components/JohnJohnSignal.jsx frontend/src/pages/Archive.jsx frontend/src/pages/Archive.test.jsx frontend/src/design/archiveTheme.js frontend/src/design/archive.css frontend/src/hooks/useTheme.js frontend/src/components/ArchiveShell.test.jsx
git commit -m "feat: refine John John's PC collection overview"
```

### Task 2: Add backward-compatible card care and provenance metadata

**Files:**
- Modify: `backend/models.py`, `backend/database.py`, `backend/schemas.py`, `backend/api/collection.py`, `frontend/src/pages/Collection.jsx`
- Create: `backend/tests/test_collection_metadata.py`, `frontend/src/utils/collectionMetadata.js`, `frontend/src/utils/collectionMetadata.test.js`

**Interfaces:** Collection rows gain nullable `acquisition_source`, `storage_type`, `storage_detail`, `grader`, `grade`, `certification_number`, and `notes`. Valid sources are pulled, bulk_before_tracking, purchased, trade, gift, and other. Omitted pulled cost defaults to 4.49; omitted bulk-before-tracking cost defaults to 0.0.

- [ ] **Step 1: Write the failing backend contract test.**

```python
def test_collection_item_persists_care_and_provenance(client, seeded_card):
    response = client.post('/api/collection/', json={
        'card_id': seeded_card.id, 'quantity': 1,
        'acquisition_source': 'pulled', 'storage_type': 'PSA Slab',
        'grader': 'PSA', 'grade': '10', 'certification_number': '12345',
    })
    assert response.status_code == 200
    assert response.json()['purchase_price'] == 4.49
    assert response.json()['grader'] == 'PSA'
```

- [ ] **Step 2: Run `pytest backend/tests/test_collection_metadata.py -v`.**
Expected: FAIL because the request model rejects the new fields.

- [ ] **Step 3: Implement the smallest migration and API change.**
Use the existing `ALTER TABLE ... ADD COLUMN` convention. Add nullable model/schema/response fields and valid-source Pydantic validation. Preserve explicit prices and existing grouping; only apply defaults when price is omitted.

- [ ] **Step 4: Run the backend test and verify it passes.**

- [ ] **Step 5: Write the failing source-default helper test.**

```js
test('uses source-aware default cost bases', () => {
  expect(defaultPurchasePrice('pulled')).toBe(4.49)
  expect(defaultPurchasePrice('bulk_before_tracking')).toBe(0)
  expect(defaultPurchasePrice('purchased')).toBeNull()
})
```

- [ ] **Step 6: Run the test, implement, and verify.**
Run: `npm --prefix frontend test -- collectionMetadata.test.js`.
Expected: FAIL because the helper does not exist.
Create source/storage constants and `defaultPurchasePrice(source)`. Add acquisition, protection/storage, optional location detail, grader, grade, certification, and note controls to CollectionEditModal. Only prefill blank prices after source selection.

- [ ] **Step 7: Build and commit.**

```bash
npm --prefix frontend test -- collectionMetadata.test.js
npm --prefix frontend run build
git add backend/models.py backend/database.py backend/schemas.py backend/api/collection.py backend/tests/test_collection_metadata.py frontend/src/pages/Collection.jsx frontend/src/utils/collectionMetadata.js frontend/src/utils/collectionMetadata.test.js
git commit -m "feat: track card provenance and care"
```

### Task 3: Keep sealed product and Binders collection-adjacent

**Files:**
- Modify: `frontend/src/pages/Collection.jsx`, `frontend/src/pages/Products.jsx`, `frontend/src/pages/Binders.jsx`, `frontend/src/pages/BinderDetail.jsx`
- Modify: `backend/models.py`, `backend/database.py`, `backend/schemas.py`, `backend/api/products.py`
- Create: `frontend/src/pages/Products.test.jsx`

**Interfaces:** Collection exposes a secondary Sealed product entry to existing `/products`. Product records gain optional storage type/detail. Binders remain Binders in visible text and continue using existing binder APIs.

- [ ] **Step 1: Write the failing entry-point test.**

```jsx
test('offers sealed product from Collection without a new primary nav item', () => {
  render(<Collection />)
  expect(screen.getByRole('link', { name: 'Sealed product' })).toHaveAttribute('href', '/products')
})
```

- [ ] **Step 2: Run `npm --prefix frontend test -- Products.test.jsx`.**
Expected: FAIL because Collection does not expose the entry.

- [ ] **Step 3: Implement the presentation/model delta.**
Add optional product storage fields through the existing product model/schema/update route. Add the Collection secondary action, retain exactly five nav items, and remove Box/archive terminology from binder surfaces without changing IDs or API calls.

- [ ] **Step 4: Verify and commit.**

```bash
npm --prefix frontend test -- Products.test.jsx
npm --prefix frontend run build
pytest backend/tests -v
git add frontend/src/pages/Collection.jsx frontend/src/pages/Products.jsx frontend/src/pages/Binders.jsx frontend/src/pages/BinderDetail.jsx frontend/src/pages/Products.test.jsx backend/models.py backend/database.py backend/schemas.py backend/api/products.py
git commit -m "feat: keep sealed product and binders collection-first"
```

### Task 4: Add Excel export and manual-import review boundary

**Files:**
- Modify: `backend/api/export.py`, `frontend/src/api/client.js`, `frontend/src/pages/Collection.jsx`
- Create: `backend/tests/test_excel_export.py`, `frontend/src/components/ImportReviewNotice.jsx`, `frontend/src/components/ImportReviewNotice.test.jsx`

**Interfaces:** `GET /api/export/xlsx` streams a workbook with Cards, Sealed Product, and Acquisition & Storage worksheets. Imports show a review notice and do not introduce automatic merge/overwrite behavior.

- [ ] **Step 1: Write the failing workbook endpoint test.**

```python
def test_excel_export_has_collection_and_sealed_sheets(client):
    response = client.get('/api/export/xlsx')
    workbook = load_workbook(BytesIO(response.content))
    assert workbook.sheetnames == ['Cards', 'Sealed Product', 'Acquisition & Storage']
    assert workbook['Cards']['A1'].value == 'Card ID'
```

- [ ] **Step 2: Run `pytest backend/tests/test_excel_export.py -v`.**
Expected: FAIL with HTTP 404 because the endpoint does not exist.

- [ ] **Step 3: Implement streaming export.**
Use installed `openpyxl` and `BytesIO`. Query only the current user’s visible cards and ProductPurchase rows. Write the three named sheets, card/provenance fields, sealed product fields, and no market/P&L/API credential information. Set a date-stamped Excel attachment filename.

- [ ] **Step 4: Run the backend test and verify it passes.**

- [ ] **Step 5: Write and run the failing review notice test.**

```jsx
test('states that imported data is reviewed before existing items change', () => {
  render(<ImportReviewNotice />)
  expect(screen.getByText(/review imported records before changing existing collection items/i)).toBeVisible()
})
```

Run: `npm --prefix frontend test -- ImportReviewNotice.test.jsx`.
Expected: FAIL because the component does not exist.

- [ ] **Step 6: Implement and verify the frontend boundary.**
Render the notice in the existing CSV import modal. Add `exportExcel()` next to `exportCSV()` and an Export Excel control in Collection.

```bash
npm --prefix frontend test -- ImportReviewNotice.test.jsx
npm --prefix frontend run build
git add backend/api/export.py backend/tests/test_excel_export.py frontend/src/api/client.js frontend/src/pages/Collection.jsx frontend/src/components/ImportReviewNotice.jsx frontend/src/components/ImportReviewNotice.test.jsx
git commit -m "feat: export John John's PC to Excel"
```

### Task 5: Document local-first controls and perform release verification

**Files:**
- Modify: `frontend/src/pages/Settings.jsx`, `docs/FRONTEND.md`, `docs/ARCHITECTURE.md`, `README.md`
- Create: `frontend/src/pages/Settings.test.jsx`

**Interfaces:** Settings has a Privacy & Data section stating that notes are local, external AI is disabled by default, imports are manual/reviewed, and Excel export is local.

- [ ] **Step 1: Write the failing Settings test.**

```jsx
test('explains the local Privacy & Data boundary', () => {
  render(<Settings />)
  expect(screen.getByRole('heading', { name: 'Privacy & Data' })).toBeVisible()
  expect(screen.getByText(/external AI is disabled by default/i)).toBeVisible()
})
```

- [ ] **Step 2: Run `npm --prefix frontend test -- Settings.test.jsx`.**
Expected: FAIL because the section is absent.

- [ ] **Step 3: Implement the informational settings/doc updates.**
Add a non-networked Privacy & Data panel. Document local notes, manual/reviewed imports, explicit external-AI opt-in, Excel export, fixed primary navigation, and legacy routes. Do not schedule weekly backup automation until the export endpoint has passed live smoke checks and a visible local destination is agreed.

- [ ] **Step 4: Run complete verification and commit.**

```bash
npm --prefix frontend test
npm --prefix frontend run build
pytest backend/tests -v
Invoke-WebRequest http://127.0.0.1:13000 -UseBasicParsing | Select-Object -ExpandProperty StatusCode
Invoke-WebRequest http://127.0.0.1:18080/openapi.json -UseBasicParsing | Select-Object -ExpandProperty StatusCode
git add frontend/src/pages/Settings.jsx frontend/src/pages/Settings.test.jsx docs/FRONTEND.md docs/ARCHITECTURE.md README.md
git commit -m "docs: document local John John's PC controls"
```
