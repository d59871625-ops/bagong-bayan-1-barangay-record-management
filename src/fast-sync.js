const delay = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds))

const readResponseJson = async (response, method) => {
  const body = await response.text()
  try {
    return JSON.parse(body)
  } catch (error) {
    const responseType = /^\s*</.test(body) ? 'an HTML error page' : 'an invalid response'
    const parseError = new Error(`${method} returned ${responseType} (HTTP ${response.status}).`, { cause: error })
    parseError.status = response.status
    throw parseError
  }
}

const createHttpError = (response, result) => {
  const error = new Error(result?.message || `Database save failed with status ${response.status}.`)
  error.status = response.status
  return error
}

const isRetryableStatus = (status) => status === 408 || status === 429 || status >= 500

const createFastSync = () => {
  let config = null
  let etag = ''
  let timer = null
  let started = false
  let pulling = null
  let saving = 0
  let saveQueue = Promise.resolve()
  let failures = 0
  let activePullController = null

  const notify = (message, failed = false, phase = 'poll') => {
    config?.onStatus?.(message, failed, phase)
  }

  const request = async (method, payload, timeoutMs) => {
    const token = config.getToken()
    if (!token) throw new Error('An active admin or official session is required.')

    const controller = new AbortController()
    let timedOut = false
    const timeoutId = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    if (method === 'GET') activePullController = controller

    const headers = { Authorization: `Bearer ${token}` }
    if (payload !== null) headers['Content-Type'] = 'application/json'
    if (method === 'GET' && etag) headers['If-None-Match'] = etag

    try {
      const response = await fetch(config.url, {
        method,
        headers,
        cache: 'no-store',
        signal: controller.signal,
        body: payload === null ? undefined : JSON.stringify(payload),
      })
      const result = response.status === 304
        ? null
        : await readResponseJson(response, method)
      return { response, result }
    } catch (error) {
      if (timedOut) {
        throw new Error(`The database ${method.toLowerCase()} timed out after ${timeoutMs / 1000} seconds.`, { cause: error })
      }
      throw error
    } finally {
      window.clearTimeout(timeoutId)
      if (method === 'GET' && activePullController === controller) activePullController = null
    }
  }

  const schedule = () => {
    if (!started) return
    window.clearTimeout(timer)
    const baseDelay = document.hidden ? config.hiddenMs : config.visibleMs
    const backoff = Math.min(config.maxBackoffMs, failures * config.backoffStepMs)
    timer = window.setTimeout(async () => {
      await pull()
      schedule()
    }, baseDelay + backoff)
  }

  const pull = () => {
    if (!started || saving > 0) return Promise.resolve(false)
    if (pulling) return pulling

    pulling = (async () => {
      const { response, result } = await request('GET', null, config.pullTimeoutMs)
      if (response.status === 401 || response.status === 403) {
        notify('Your session expired. Sign in again.', true)
        config.onAuthError?.()
        return false
      }
      if (response.status === 304) {
        failures = 0
        notify('Database is up to date.', false)
        return true
      }
      if (!response.ok || !result?.success || !result.data
        || typeof result.data !== 'object' || Array.isArray(result.data)) {
        throw createHttpError(response, result)
      }

      etag = response.headers.get('ETag') || ''
      config.onEtag?.(etag)
      await config.onData(result.data)
      failures = 0
      notify('Database synchronized.', false)
      return true
    })()
      .catch((error) => {
        if (started) {
          failures += 1
          notify(error.message || 'Database synchronization failed.', true)
        }
        return false
      })
      .finally(() => {
        pulling = null
      })

    return pulling
  }

  const executeSaveMany = async (payloads) => {
    if (!started || !config) throw new Error('Database synchronization is not active.')
    if (!Array.isArray(payloads) || payloads.length === 0) {
      throw new Error('There are no shared database changes to save.')
    }

    saving += 1
    let saved = false
    try {
      if (pulling) await pulling
      for (const payload of payloads) {
        let lastError
        for (let attempt = 0; attempt < config.saveRetries; attempt += 1) {
          try {
            const { response, result } = await request('POST', payload, config.saveTimeoutMs)
            if (response.status === 401 || response.status === 403) {
              config.onAuthError?.()
              throw createHttpError(response, result)
            }
            if (!response.ok || !result?.success) {
              const error = createHttpError(response, result)
              if (!isRetryableStatus(response.status)) throw error
              throw error
            }
            lastError = null
            break
          } catch (error) {
            lastError = error
            const retryable = error.status === undefined || isRetryableStatus(error.status)
            if (!retryable || attempt === config.saveRetries - 1) break
            notify('Retrying database save…', true, 'save')
            await delay(config.retryDelayMs * (attempt + 1))
          }
        }
        if (lastError) throw lastError
      }
      saved = true
      notify('Changes saved to the shared database.', false, 'save')
    } catch (error) {
      notify(error.message || 'Database save failed.', true, 'save')
      throw error
    } finally {
      saving -= 1
      if (saved) {
        etag = ''
        if (started) void pull()
      }
      schedule()
    }
  }

  const saveMany = (payloads) => {
    const save = saveQueue.catch(() => {}).then(() => executeSaveMany(payloads))
    saveQueue = save.catch(() => {})
    return save
  }
  const save = (payload) => saveMany([payload])

  const handleVisibilityChange = () => {
    if (!document.hidden) void pull()
    schedule()
  }
  const handleOnline = () => {
    void pull()
    schedule()
  }

  const stop = () => {
    if (!started) return
    started = false
    window.clearTimeout(timer)
    activePullController?.abort()
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('online', handleOnline)
    window.removeEventListener('focus', handleOnline)
  }

  const start = (options = {}) => {
    stop()
    config = {
      url: 'api.php',
      getToken: () => '',
      onData: () => {},
      onAuthError: null,
      onStatus: null,
      onEtag: null,
      initialEtag: '',
      visibleMs: 5000,
      hiddenMs: 30000,
      pullTimeoutMs: 15000,
      saveTimeoutMs: 25000,
      saveRetries: 4,
      retryDelayMs: 800,
      backoffStepMs: 2000,
      maxBackoffMs: 30000,
      ...options,
    }
    etag = config.initialEtag || ''
    started = true
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('online', handleOnline)
    window.addEventListener('focus', handleOnline)
    void pull()
    schedule()
  }

  return { start, stop, pull, save, saveMany, isActive: () => started }
}

export default createFastSync
