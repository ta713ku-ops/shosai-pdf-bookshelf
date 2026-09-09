import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerPwa } from './pwa'
import workerSource from '../public/sw.js?raw'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('PWA registration', () => {
  it('registers within the configured deployment path without caching the worker script', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('BASE_URL', '/books/')
    const register = vi.fn().mockResolvedValue({ scope: '/books/' })
    vi.stubGlobal('navigator', { serviceWorker: { register } })
    await registerPwa()
    expect(register).toHaveBeenCalledWith('/books/sw.js', { scope: '/books/', updateViaCache: 'none' })
  })
  it('leaves the library usable when registration fails', async () => {
    vi.stubEnv('DEV', false)
    vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn().mockRejectedValue(new Error('unavailable')) } })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await registerPwa()).toBeUndefined()
  })
})

describe('service worker request boundaries', () => {
  it('uses a cached shell on network failure and deletes only its own obsolete caches', async () => {
    const handlers = new Map<string, (event: unknown) => void>()
    const cachedShell = new Response('<html>書斎</html>')
    const cache = { match: vi.fn().mockResolvedValue(cachedShell) }
    const storage = { open: vi.fn().mockResolvedValue(cache), keys: vi.fn().mockResolvedValue(['shosai-shell-v0', 'shosai-shell-v1', 'another-app']), delete: vi.fn().mockResolvedValue(true) }
    const claim = vi.fn()
    const worker = { registration: { scope: 'https://example.test/books/' }, clients: { claim }, addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) }
    new Function('self', 'caches', 'fetch', workerSource)(worker, storage, vi.fn().mockRejectedValue(new Error('offline')))
    let response: Promise<Response> | undefined
    handlers.get('fetch')!({ request: { url: 'https://example.test/books/', method: 'GET', mode: 'navigate' }, respondWith: (value: Promise<Response>) => { response = value } })
    expect(await response).toBe(cachedShell)
    let activation: Promise<void> | undefined
    handlers.get('activate')!({ waitUntil: (value: Promise<void>) => { activation = value } })
    await activation
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith('shosai-shell-v0')
    expect(claim).toHaveBeenCalledOnce()
  })
  it('does not intercept PDFs, external files, API data, or query-bearing URLs', () => {
    const handlers = new Map<string, (event: unknown) => void>()
    const worker = { registration: { scope: 'https://example.test/books/' }, addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) }
    new Function('self', workerSource)(worker)
    for (const url of ['https://example.test/books/book.pdf', 'https://elsewhere.test/assets/a.js', 'https://example.test/books/api/library', 'https://example.test/books/assets/a.js?token=secret']) {
      const respondWith = vi.fn()
      handlers.get('fetch')!({ request: { url, method: 'GET', mode: 'navigate' }, respondWith })
      expect(respondWith).not.toHaveBeenCalled()
    }
  })
})
