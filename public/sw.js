/* Only the application shell belongs here. PDFs and library data stay in IndexedDB. */
const CACHE_PREFIX = 'shosai-shell-'
const CACHE_NAME = `${CACHE_PREFIX}v5`
const BASE = new URL('./', self.registration.scope)
const SHELL = new URL('index.html', BASE).href
const SHELL_URLS = [SHELL, new URL('manifest.webmanifest', BASE).href, new URL('icon.svg', BASE).href, new URL('apple-touch-icon.png', BASE).href]

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    await cache.addAll(SHELL_URLS)
    // Capture Vite's entry scripts and styles on the first visit as well.
    const html = await (await cache.match(SHELL)).text()
    const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => new URL(match[1], SHELL))
      .filter((url) => url.origin === BASE.origin && url.pathname.startsWith(`${BASE.pathname}assets/`) && !url.search && /\.(?:js|css)$/.test(url.pathname))
      .map((url) => url.href)
    await cache.addAll([...new Set(assets)])
    // Follow Vite's lazy imports as well. Reader, PDF.js and its worker must be
    // ready before an existing local book is opened during the first offline visit.
    const knownAssets = new Set(assets)
    const pendingScripts = assets.filter((url) => url.endsWith('.js') || url.endsWith('.mjs'))
    while (pendingScripts.length) {
      const asset = pendingScripts.shift()
      const script = await (await cache.match(asset)).text()
      for (const match of script.matchAll(/["']([^"']+\.(?:js|mjs|css))["']/g)) {
        const dependency = new URL(match[1], match[1].startsWith('assets/') ? BASE : asset)
        if (dependency.origin !== BASE.origin || !dependency.pathname.startsWith(`${BASE.pathname}assets/`) || dependency.search || knownAssets.has(dependency.href)) continue
        knownAssets.add(dependency.href)
        // Bundled libraries can retain source-level filenames alongside Vite's
        // emitted URL. A missing source filename must not abort installation.
        try {
          await cache.add(dependency.href)
        } catch {
          continue
        }
        if (dependency.pathname.endsWith('.js') || dependency.pathname.endsWith('.mjs')) pendingScripts.push(dependency.href)
      }
    }
  })())
  // Let open readers finish before a new service worker takes over.
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

function canStore(response) {
  return response.ok && response.type !== 'opaque' && !response.redirected
    && !/no-store|private/i.test(response.headers.get('Cache-Control') || '')
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname) || url.search) return
  const relativePath = url.pathname.slice(BASE.pathname.length)
  // Navigation caching is intentionally limited to the app entry, never PDF URLs.
  const isShellNavigation = request.mode === 'navigate' && (relativePath === '' || relativePath === 'index.html')
  const isStatic = SHELL_URLS.includes(url.href) || /^assets\/[\w./-]+\.(?:js|mjs|css|woff2?|png|svg|webp|jpg|jpeg|ico)$/.test(relativePath)
  if (!isShellNavigation && !isStatic) return

  if (isShellNavigation) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME)
      try {
        const response = await fetch(request)
        if (canStore(response) && (response.headers.get('Content-Type') || '').includes('text/html')) await cache.put(SHELL, response.clone())
        return response
      } catch {
        return await cache.match(SHELL) || new Response('オフラインです。接続後に書斎を開き直してください。', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }
    })())
    return
  }

  const refreshed = (async () => {
    const response = await fetch(request)
    if (canStore(response)) {
      const cache = await caches.open(CACHE_NAME)
      await cache.put(request, response.clone())
    }
    return response
  })()
  event.waitUntil(refreshed.then(() => undefined, () => undefined))
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME)
    return await cache.match(request) || await refreshed.catch(() => new Response('', { status: 503, statusText: 'Offline' }))
  })())
})
