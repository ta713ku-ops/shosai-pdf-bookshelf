/** Registration failure must never prevent access to the user's local library. */
export async function registerPwa(): Promise<ServiceWorkerRegistration | undefined> {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return undefined
  try {
    return await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
      updateViaCache: 'none',
    })
  } catch (error) {
    console.warn('オフライン機能を準備できませんでした。', error)
    return undefined
  }
}
