import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ArchiveShell from './ArchiveShell'

test('shows the five familiar primary destinations', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<ArchiveShell />}>
          <Route index element={<h1>Your Archive</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>
  )

  expect(screen.getByRole('link', { name: 'Collection' })).toBeVisible()
  expect(screen.getByRole('link', { name: 'Card Search' })).toBeVisible()
  expect(screen.getByRole('link', { name: 'Sets' })).toBeVisible()
  expect(screen.getByRole('link', { name: 'Analytics' })).toBeVisible()
  expect(screen.getByRole('link', { name: 'Settings' })).toBeVisible()
})
