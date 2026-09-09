import { afterEach, describe, expect, it, vi } from 'vitest'
import { canRequestFullscreen, exitAppFullscreen, isDocumentFullscreen, requestAppFullscreen } from './fullscreen'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null })
  Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: undefined })
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: undefined })
})

describe('fullscreen helpers', () => {
  it('requests fullscreen when the browser supports it', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: request })
    expect(canRequestFullscreen()).toBe(true)
    expect(await requestAppFullscreen()).toBe(true)
    expect(request).toHaveBeenCalledOnce()
  })

  it('keeps reading when a fullscreen request is rejected', async () => {
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: vi.fn().mockRejectedValue(new Error('Not allowed')),
    })
    expect(await requestAppFullscreen()).toBe(false)
  })

  it('exits an active fullscreen session', async () => {
    const exit = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.documentElement })
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
    expect(isDocumentFullscreen()).toBe(true)
    await exitAppFullscreen()
    expect(exit).toHaveBeenCalledOnce()
  })
})
