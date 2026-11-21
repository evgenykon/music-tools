/**
 * Detect a newer deployment of the static build.
 *
 * The deploy workflow writes `version.json` (git sha + build time) next to the
 * app; this composable compares it with the build id baked into the bundle.
 * Nothing reloads on its own — the UI shows a banner and the user decides.
 */
export function useAppUpdate() {
  const config = useRuntimeConfig()
  const base = config.app.baseURL
  const buildId = String(config.public.buildId || 'dev')

  const available = ref(false)
  const latestBuild = ref('')
  const checking = ref(false)

  async function check() {
    if (import.meta.server || checking.value) return
    checking.value = true
    try {
      const response = await fetch(`${base}version.json?t=${Date.now()}`, { cache: 'no-store' })
      if (!response.ok) return
      const data = (await response.json()) as { build?: string }
      if (!data.build) return
      latestBuild.value = data.build
      // A dev build (no sha) never nags: everything is "newer" than 'dev'.
      available.value = buildId !== 'dev' && data.build !== buildId
    } catch {
      /* offline or blocked: nothing to do */
    } finally {
      checking.value = false
    }
  }

  function applyUpdate() {
    const url = new URL(window.location.href)
    url.searchParams.set('v', latestBuild.value || String(Date.now()))
    window.location.replace(url.toString())
  }

  let timer = 0

  function onVisible() {
    if (document.visibilityState === 'visible') check()
  }

  onMounted(() => {
    check()
    timer = window.setInterval(check, 5 * 60 * 1000)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', check)
  })

  onBeforeUnmount(() => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('focus', check)
  })

  return { available, latestBuild, buildId, checking, check, applyUpdate }
}
