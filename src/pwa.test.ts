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
  it('pre-caches lazy reader, PDF, stylesheet, and worker assets for first offline use', async () => {
    const handlers = new Map<string, (event: unknown) => void>()
    const sources = new Map([
      ['https://example.test/books/index.html', '<script src="/books/assets/index-a.js"></script><link href="/books/assets/index-a.css">'],
      ['https://example.test/books/assets/index-a.js', 'const deps=["assets/Reader-b.css","assets/pdf-c.js"]; import("./Reader-b.js")'],
      ['https://example.test/books/assets/Reader-b.js', 'export const Reader = true'],
      ['https://example.test/books/assets/pdf-c.js', 'new URL("/books/assets/pdf.worker-d.mjs", import.meta.url)'],
      ['https://example.test/books/assets/pdf.worker-d.mjs', 'self.onmessage=()=>{}'],
    ])
    const cache = {
      addAll: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(undefined),
      match: vi.fn(async (url: string) => new Response(sources.get(url) ?? '')),
    }
    const storage = { open: vi.fn().mockResolvedValue(cache) }
    const worker = { registration: { scope: 'https://example.test/books/' }, addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) }
    new Function('self', 'caches', workerSource)(worker, storage)
    let installation: Promise<void> | undefined
    handlers.get('install')!({ waitUntil: (value: Promise<void>) => { installation = value } })
    await installation
    expect(cache.add).toHaveBeenCalledWith('https://example.test/books/assets/Reader-b.js')
    expect(cache.add).toHaveBeenCalledWith('https://example.test/books/assets/Reader-b.css')
    expect(cache.add).toHaveBeenCalledWith('https://example.test/books/assets/pdf-c.js')
    expect(cache.add).toHaveBeenCalledWith('https://example.test/books/assets/pdf.worker-d.mjs')
  })

  it('ignores source-only dependency names without aborting installation', async () => {
    const handlers = new Map<string, (event: unknown) => void>()
    const sources = new Map([
      ['https://example.test/books/index.html', '<script src="/books/assets/index-a.js"></script>'],
      ['https://example.test/books/assets/index-a.js', 'import("./pdf-c.js")'],
      ['https://example.test/books/assets/pdf-c.js', 'const source="./pdf.worker.mjs"; new URL("/books/assets/pdf.worker-d.mjs", import.meta.url)'],
      ['https://example.test/books/assets/pdf.worker-d.mjs', 'self.onmessage=()=>{}'],
    ])
    const cache = {
      addAll: vi.fn().mockResolvedValue(undefined),
      add: vi.fn(async (url: string) => {
        if (!sources.has(url)) throw new Error('404')
      }),
      match: vi.fn(async (url: string) => new Response(sources.get(url) ?? '')),
    }
    const worker = {
      registration: { scope: 'https://example.test/books/' },
      addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
    }
    new Function('self', 'caches', workerSource)(worker, { open: vi.fn().mockResolvedValue(cache) })
    let installation: Promise<void> | undefined
    handlers.get('install')!({ waitUntil: (value: Promise<void>) => { installation = value } })
    await expect(installation).resolves.toBeUndefined()
    expect(cache.add).toHaveBeenCalledWith('https://example.test/books/assets/pdf.worker.mjs')
    expect(cache.add).toHaveBeenCalledWith('https://example.test/books/assets/pdf.worker-d.mjs')
  })

  it('uses a cached shell on network failure and deletes only its own obsolete caches', async () => {
    const handlers = new Map<string, (event: unknown) => void>()
    const cachedShell = new Response('<html>書斎</html>')
    const cache = { match: vi.fn().mockResolvedValue(cachedShell) }
    const storage = { open: vi.fn().mockResolvedValue(cache), keys: vi.fn().mockResolvedValue(['shosai-shell-v0', 'shosai-shell-v1', 'shosai-shell-v2', 'another-app']), delete: vi.fn().mockResolvedValue(true) }
    const claim = vi.fn()
    const worker = { registration: { scope: 'https://example.test/books/' }, clients: { claim }, addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) }
    new Function('self', 'caches', 'fetch', workerSource)(worker, storage, vi.fn().mockRejectedValue(new Error('offline')))
    let response: Promise<Response> | undefined
    handlers.get('fetch')!({ request: { url: 'https://example.test/books/', method: 'GET', mode: 'navigate' }, respondWith: (value: Promise<Response>) => { response = value } })
    expect(await response).toBe(cachedShell)
    let activation: Promise<void> | undefined
    handlers.get('activate')!({ waitUntil: (value: Promise<void>) => { activation = value } })
    await activation
    expect(storage.delete).toHaveBeenCalledTimes(2)
    expect(storage.delete).toHaveBeenCalledWith('shosai-shell-v0')
    expect(storage.delete).toHaveBeenCalledWith('shosai-shell-v1')
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
