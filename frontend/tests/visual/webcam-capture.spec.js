import { expect, test } from '@playwright/test'

async function openFixture(page) {
  await page.route('**/api/settings/scanner', route => route.fulfill({ json: { visual_verification: 'automatic' } }))
  await page.goto('/tests/fixtures/webcam.html')
  await page.waitForFunction(() => window.webcamTest?.ready)
}

async function mountCamera(page) {
  await page.evaluate(() => webcamTest.mount())
  await expect(page.getByRole('button', { name: 'Capture', exact: true })).toBeEnabled()
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0)
}

test('an encoded photo finishing after Done is discarded', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => { webcamTest.delayEncoding = true })
  await mountCamera(page)
  await page.getByRole('button', { name: 'Capture', exact: true }).click()
  await expect.poll(() => page.evaluate(() => webcamTest.encodings.length)).toBe(1)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.locator('video')).toHaveCount(0)
  await page.evaluate(() => new Promise(resolve => { webcamTest.encodings.shift()(); setTimeout(resolve, 100) }))
  expect(await page.evaluate(() => webcamTest.captures)).toEqual([])
  expect(await page.evaluate(() => webcamTest.stopped)).toBe(1)
})

test('rapid capture requests encode one photo at a time', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => { webcamTest.delayEncoding = true })
  await mountCamera(page)
  await page.evaluate(() => {
    const capture = [...document.querySelectorAll('button')].find(button => button.textContent === 'Capture')
    capture.click(); capture.click()
  })
  expect(await page.evaluate(() => webcamTest.encodings.length)).toBe(1)
})

test('keyboard activation of Done does not capture or trap focus', async ({ page }) => {
  await openFixture(page)
  await mountCamera(page)
  await page.getByRole('button', { name: 'Done', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('video')).toHaveCount(0)
  expect(await page.evaluate(() => webcamTest.captures)).toEqual([])
})

test('stability sampling uses the visible guide rather than the background', async ({ page }) => {
  await openFixture(page)
  await mountCamera(page)
  await expect.poll(() => page.evaluate(() => webcamTest.drawn.length)).toBeGreaterThan(0)
  const sample = await page.evaluate(() => webcamTest.drawn.at(-1))
  expect(sample).toHaveLength(8)
  expect(sample[0]).toBeGreaterThan(0)
  expect(sample[2]).toBeLessThan(640)
  expect(sample[3]).toBeLessThan(480)
})

test('clearing a batch stops the camera before the confirmation opens', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => webcamTest.mount('scanner'))
  await page.getByRole('button', { name: 'Take photos', exact: true }).click()
  await page.getByRole('button', { name: 'Continuous capture', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0)
  await page.getByRole('button', { name: 'Capture', exact: true }).click()
  await expect(page.getByText('1/50 photos', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Clear batch', exact: true }).click()
  await expect(page.locator('video')).toHaveCount(0)
  expect(await page.evaluate(() => webcamTest.stopped)).toBe(1)
})

test('closing a staged scanner stops the camera before discard confirmation', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => webcamTest.mount('scanner'))
  await page.getByRole('button', { name: 'Take photos', exact: true }).click()
  await page.getByRole('button', { name: 'Continuous capture', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0)
  await page.getByRole('button', { name: 'Capture', exact: true }).click()
  await expect(page.getByText('1/50 photos', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.locator('video')).toHaveCount(0)
})

test('reopening an externally hidden scanner does not restart the camera', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => webcamTest.mount('scanner'))
  await page.getByRole('button', { name: 'Take photos', exact: true }).click()
  await page.getByRole('button', { name: 'Continuous capture', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0)
  await page.evaluate(() => webcamTest.mount('scanner', { isOpen: false }))
  await expect(page.locator('video')).toHaveCount(0)
  await page.evaluate(() => webcamTest.mount('scanner'))
  await expect(page.getByRole('button', { name: 'Take photos', exact: true })).toBeVisible()
  expect(await page.evaluate(() => webcamTest.requests.length)).toBe(1)
})

test('submitting photos stops the camera and failed upload preserves the batch', async ({ page }) => {
  await openFixture(page)
  const uploads = []
  await page.route('**/api/cards/recognize/jobs', async route => {
    uploads.push(route.request().postDataBuffer().toString('latin1'))
    await route.fulfill({ status: 503, json: { detail: 'Fixture upload failure' } })
  })
  await page.evaluate(() => webcamTest.mount('scanner'))
  await page.getByRole('button', { name: 'Take photos', exact: true }).click()
  await page.getByRole('button', { name: 'Continuous capture', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0)
  await page.getByRole('button', { name: 'Capture', exact: true }).click()
  await expect(page.getByText('1/50 photos', { exact: true })).toBeVisible()
  expect(uploads).toHaveLength(0)
  await expect(page.getByRole('button', { name: 'Start scanning', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Start scanning', exact: true }).click()
  await expect.poll(() => uploads.length).toBe(1)
  await expect(page.locator('video')).toHaveCount(0)
  await expect(page.getByText('1/50 photos', { exact: true })).toBeVisible()
  expect(uploads[0]).toContain('Content-Type: image/jpeg')
  expect(uploads[0]).toContain('filename="webcam-')
})

test('same-turn file arrivals cannot exceed the 50-photo batch limit', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => webcamTest.mount('scanner'))
  await expect(page.getByRole('button', { name: 'Take photos', exact: true })).toBeVisible()
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  await page.locator('input[type=file][multiple]').setInputFiles(Array.from({ length: 49 }, (_, n) => ({ name: `photo-${n}.png`, mimeType: 'image/png', buffer: pixel })))
  await expect(page.getByText('49/50 photos', { exact: true })).toBeVisible()
  await page.evaluate(() => {
    const input = document.querySelector('input[type=file][multiple]')
    for (let n = 0; n < 2; n++) {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['fixture'], `last-${n}.png`, { type: 'image/png' }))
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }
  })
  await expect(page.getByText('50/50 photos', { exact: true })).toBeVisible()
})

test('an interrupted camera releases the stream and offers retry', async ({ page }) => {
  await openFixture(page)
  await mountCamera(page)
  await page.evaluate(() => webcamTest.streams[0].getVideoTracks()[0].dispatchEvent(new Event('ended')))
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  expect(await page.evaluate(() => webcamTest.stopped)).toBe(1)
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Capture', exact: true })).toBeEnabled()
})

test('failed video playback is not reported as a live camera', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => { webcamTest.playError = true; webcamTest.mount() })
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Capture', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => webcamTest.stopped)).toBe(1)
})

test('a permission grant arriving after exit is immediately released', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => { webcamTest.deferred = true; webcamTest.mount() })
  await page.waitForFunction(() => typeof webcamTest.grant === 'function')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.evaluate(() => webcamTest.grant())
  await expect.poll(() => page.evaluate(() => webcamTest.stopped)).toBe(1)
  expect(await page.evaluate(() => webcamTest.streams[0].getTracks()[0].readyState)).toBe('ended')
})

test('retry discards the interrupted camera encoding without unlocking a new one', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => { webcamTest.delayEncoding = true })
  await mountCamera(page)
  await page.getByRole('button', { name: 'Capture', exact: true }).click()
  await page.evaluate(() => webcamTest.streams[0].getVideoTracks()[0].dispatchEvent(new Event('ended')))
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Capture', exact: true })).toBeEnabled()
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0)
  await page.getByRole('button', { name: 'Capture', exact: true }).click()
  await page.evaluate(() => new Promise(resolve => { webcamTest.encodings.shift()(); setTimeout(resolve, 100) }))
  expect(await page.evaluate(() => webcamTest.captures)).toEqual([])
  await page.getByRole('button', { name: 'Capture', exact: true }).click()
  expect(await page.evaluate(() => webcamTest.encodings.length)).toBe(1)
  await page.evaluate(() => webcamTest.encodings.shift()())
  await expect.poll(() => page.evaluate(() => webcamTest.captures.length)).toBe(1)
  expect(await page.evaluate(() => webcamTest.requests[1].video.facingMode)).toBe('environment')
  expect(await page.evaluate(() => webcamTest.stopped)).toBe(1)
})

for (const [error, message] of [
  ['NotAllowedError', 'Camera access was denied. Allow camera access in your browser settings and try again.'],
  ['NotFoundError', 'No camera was found on this device.'],
  ['NotReadableError', 'The camera feed could not be started.'],
]) {
  test(`camera ${error} offers a working retry`, async ({ page }) => {
    await openFixture(page)
    await page.evaluate(error => { webcamTest.error = error; webcamTest.mount() }, error)
    await expect(page.getByText(message, { exact: true })).toBeVisible()
    await page.evaluate(() => { webcamTest.error = null })
    await page.getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Capture', exact: true })).toBeEnabled()
  })
}

test('automatic capture waits for a new scene before capturing again', async ({ page }) => {
  await openFixture(page)
  await mountCamera(page)
  const paint = invert => {
    const canvas = webcamTest.canvas
    const ctx = canvas.getContext('2d')
    for (let x = 0; x < canvas.width; x += 10) {
      ctx.fillStyle = ((x / 10) % 2 === 0) !== invert ? '#000' : '#fff'
      ctx.fillRect(x, 0, 10, canvas.height)
    }
    webcamTest.streams.at(-1).getVideoTracks()[0].requestFrame()
  }
  await page.evaluate(paint, false)
  await expect.poll(() => page.evaluate(() => webcamTest.captures.length)).toBe(1)
  await page.waitForTimeout(1000)
  expect(await page.evaluate(() => webcamTest.captures.length)).toBe(1)
  await page.evaluate(paint, true)
  await expect.poll(() => page.evaluate(() => webcamTest.captures.length)).toBe(2)
})

test('keyboard capture works outside controls but ignores repeated keydown', async ({ page }) => {
  await openFixture(page)
  await mountCamera(page)
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press('Space')
  await expect.poll(() => page.evaluate(() => webcamTest.captures.length)).toBe(1)
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', repeat: true })))
  await page.waitForTimeout(100)
  expect(await page.evaluate(() => webcamTest.captures.length)).toBe(1)
})

test('an insecure context leaves webcam capture disabled', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => { Object.defineProperty(window, 'isSecureContext', { value: false }); webcamTest.mount('scanner') })
  await page.getByRole('button', { name: 'Take photos', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Continuous capture', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Single photo', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => webcamTest.requests)).toEqual([])
})


test('one Take photos entry offers native or continuous capture without starting a camera', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => webcamTest.mount('scanner'))
  await expect(page.getByRole('button', { name: 'Use webcam', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Choose from gallery', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Take photos', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Single photo', exact: true })).toBeFocused()
  await expect(page.getByRole('button', { name: 'Continuous capture', exact: true })).toBeVisible()
  await expect(page.getByText('Keep the camera open and take photos automatically when each card is held steady.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => webcamTest.requests.length)).toBe(0)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Single photo', exact: true }).click()
  const input = await chooser
  expect(await input.element().getAttribute('capture')).toBe('environment')
  expect(input.isMultiple()).toBe(false)
  expect(await page.evaluate(() => webcamTest.requests.length)).toBe(0)
  await page.getByRole('button', { name: 'Take photos', exact: true }).click()
  await page.getByRole('button', { name: 'Continuous capture', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Capture', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => webcamTest.requests.length)).toBe(1)
})


test('cancelling capture choice preserves photos and restores the camera entry focus', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => webcamTest.mount('scanner'))
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const gallery = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose from gallery', exact: true }).click()
  const picker = await gallery
  expect(picker.isMultiple()).toBe(true)
  expect(await picker.element().getAttribute('capture')).toBe(null)
  await picker.setFiles({ name: 'existing.png', mimeType: 'image/png', buffer: pixel })
  await expect(page.getByText('1/50 photos', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Take photos', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Take photos', exact: true })).toBeFocused()
  await expect(page.getByText('1/50 photos', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => webcamTest.requests.length)).toBe(0)
  await page.getByRole('button', { name: 'Take photos', exact: true }).click()
  const single = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Single photo', exact: true }).click()
  await (await single).setFiles({ name: 'native.png', mimeType: 'image/png', buffer: pixel })
  await expect(page.getByText('2/50 photos', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => webcamTest.requests.length)).toBe(0)
})

test('missing live camera API keeps native capture available', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    webcamTest.mount('scanner')
  })
  await page.getByRole('button', { name: 'Take photos', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Continuous capture', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Single photo', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => webcamTest.requests.length)).toBe(0)
})


test('portrait phone preview has a large guide and desktop keeps its wide preview', async ({ page }, testInfo) => {
  await openFixture(page)
  await mountCamera(page)
  const preview = await page.locator('video').boundingBox()
  const guide = await page.locator('[data-camera-guide]').boundingBox()
  if (testInfo.project.name === 'mobile') {
    expect(guide.width / preview.width).toBeGreaterThan(0.7)
    expect(preview.height / preview.width).toBeGreaterThan(1)
  } else {
    expect(guide.width).toBeGreaterThan(0)
    expect(preview.width / preview.height).toBeGreaterThan(1.5)
  }
})

test('capture has no configuration controls and requires Done before Start scanning', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => webcamTest.mount('scanner'))
  await page.getByRole('button', { name: 'Take photos', exact: true }).click()
  await page.getByRole('button', { name: 'Continuous capture', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Capture', exact: true })).toBeEnabled()
  await expect(page.getByRole('combobox')).toHaveCount(0)
  await expect(page.getByTestId('camera-info')).toHaveCount(0)
  await page.getByRole('button', { name: 'Capture', exact: true }).click()
  await expect(page.getByText('1/50 photos', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start scanning', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start scanning', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => webcamTest.stopped)).toBe(1)
})

for (const height of [568, 667, 844]) {
  test(`camera and controls fit a phone screen at height ${height}`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height })
    await openFixture(page)
    await page.evaluate(() => webcamTest.mount('scanner'))
    await page.getByRole('button', { name: 'Take photos', exact: true }).click()
    await page.getByRole('button', { name: 'Continuous capture', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Capture', exact: true })).toBeEnabled()
    await expect.poll(() => page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')
      return [...dialog.querySelectorAll('*')].filter(e => getComputedStyle(e).overflowY === 'auto').every(e => e.scrollHeight <= e.clientHeight + 2 && e.scrollTop <= 2)
    })).toBe(true)
    for (const label of ['Capture', 'Done']) {
      const rect = await page.getByRole('button', { name: label, exact: true }).boundingBox()
      expect(rect.y).toBeGreaterThanOrEqual(0)
      expect(rect.y + rect.height).toBeLessThanOrEqual(height)
    }
  })
}


test('batch limit keeps capture open until Done', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => webcamTest.mount('scanner'))
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  await page.locator('input[type=file][multiple]').setInputFiles(Array.from({ length: 49 }, (_, n) => ({ name: `photo-${n}.png`, mimeType: 'image/png', buffer: pixel })))
  await page.getByRole('button', { name: 'Take photos', exact: true }).click()
  await page.getByRole('button', { name: 'Continuous capture', exact: true }).click()
  await page.getByRole('button', { name: 'Capture', exact: true }).click()
  await expect(page.getByText('50/50 photos', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Capture', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Start scanning', exact: true })).toHaveCount(0)
  await expect(page.locator('video')).toHaveCount(1)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start scanning', exact: true })).toBeEnabled()
  await expect(page.locator('video')).toHaveCount(0)
})
