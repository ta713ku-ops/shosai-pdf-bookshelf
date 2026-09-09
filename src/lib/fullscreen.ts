type WebkitFullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

type WebkitFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
}

type StandaloneNavigator = Navigator & { standalone?: boolean }

export function isStandaloneDisplay() {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || Boolean((navigator as StandaloneNavigator).standalone)
}

export function isDocumentFullscreen() {
  const fullscreenDocument = document as WebkitFullscreenDocument
  return Boolean(document.fullscreenElement || fullscreenDocument.webkitFullscreenElement)
}

export function canRequestFullscreen() {
  const root = document.documentElement as WebkitFullscreenElement
  return typeof root.requestFullscreen === 'function' || typeof root.webkitRequestFullscreen === 'function'
}

export async function requestAppFullscreen() {
  if (isStandaloneDisplay() || isDocumentFullscreen()) return true
  const root = document.documentElement as WebkitFullscreenElement
  const request = root.requestFullscreen ?? root.webkitRequestFullscreen
  if (!request) return false
  try {
    await request.call(root)
    return true
  } catch {
    return false
  }
}

export async function exitAppFullscreen() {
  if (!isDocumentFullscreen()) return
  const fullscreenDocument = document as WebkitFullscreenDocument
  const exit = document.exitFullscreen ?? fullscreenDocument.webkitExitFullscreen
  if (!exit) return
  try {
    await exit.call(document)
  } catch {
    // The browser may already be leaving fullscreen after a system gesture.
  }
}

export function addFullscreenChangeListener(listener: () => void) {
  document.addEventListener('fullscreenchange', listener)
  document.addEventListener('webkitfullscreenchange', listener)
  return () => {
    document.removeEventListener('fullscreenchange', listener)
    document.removeEventListener('webkitfullscreenchange', listener)
  }
}
