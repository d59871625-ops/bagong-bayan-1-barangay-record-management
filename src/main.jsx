import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

const appBuildVersion = import.meta.env.VITE_APP_BUILD_VERSION
let appVersionCheckInFlight = false
let lastAppVersionCheck = 0
let appRoot

const showAppUpdateFailure = () => {
  appRoot?.unmount()
  const notice = document.createElement('main')
  notice.setAttribute('role', 'alert')
  notice.style.cssText = 'max-width:560px;margin:12vh auto;padding:24px;font:16px/1.5 system-ui,sans-serif;color:#243328'

  const title = document.createElement('h1')
  title.textContent = 'A system update is available'
  const message = document.createElement('p')
  message.textContent = 'This device could not load the current version. Reopen the system or try refreshing again.'
  const refreshButton = document.createElement('button')
  refreshButton.type = 'button'
  refreshButton.textContent = 'Load current version'
  refreshButton.style.cssText = 'min-height:44px;padding:8px 14px;border:0;border-radius:8px;background:#34774a;color:#fff;font:700 14px system-ui,sans-serif'
  refreshButton.addEventListener('click', () => {
    const url = new URL(window.location.href)
    url.searchParams.set('__bb1_build', `${Date.now()}`)
    window.location.replace(url.href)
  })

  notice.append(title, message, refreshButton)
  document.body.replaceChildren(notice)
}

const verifyCurrentAppVersion = async () => {
  if (import.meta.env.DEV || !appBuildVersion || appVersionCheckInFlight
    || Date.now() - lastAppVersionCheck < 15000) return

  appVersionCheckInFlight = true
  lastAppVersionCheck = Date.now()
  try {
    const versionUrl = new URL('/version.json', window.location.origin)
    versionUrl.searchParams.set('check', `${Date.now()}`)
    const response = await fetch(versionUrl, { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) throw new Error(`Version check failed with status ${response.status}.`)

    const result = await response.json()
    if (!result || typeof result.version !== 'string' || !result.version) {
      throw new Error('The system version response is invalid.')
    }

    if (result.version !== appBuildVersion) {
      const currentUrl = new URL(window.location.href)
      if (currentUrl.searchParams.get('__bb1_build') === result.version) {
        showAppUpdateFailure()
        return
      }
      currentUrl.searchParams.set('__bb1_build', result.version)
      window.location.replace(currentUrl.href)
      return
    }

    const currentUrl = new URL(window.location.href)
    if (currentUrl.searchParams.has('__bb1_build')) {
      currentUrl.searchParams.delete('__bb1_build')
      window.history.replaceState(window.history.state, '', currentUrl.href)
    }
  } catch (error) {
    console.error('Unable to verify the latest system version.', error)
  } finally {
    appVersionCheckInFlight = false
  }
}

window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    window.location.reload()
    return
  }
  void verifyCurrentAppVersion()
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void verifyCurrentAppVersion()
})
window.addEventListener('focus', () => void verifyCurrentAppVersion())

appRoot = createRoot(document.getElementById('root'))
appRoot.render(
  <StrictMode>
    <App />
  </StrictMode>,
)
void verifyCurrentAppVersion()
