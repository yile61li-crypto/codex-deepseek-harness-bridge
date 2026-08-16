import { randomUUID } from 'node:crypto'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const DEFAULT_TIMEOUT_MS = 30_000

export class DshRpcError extends Error {
  constructor(message, { code = 'dsh-error', details, method } = {}) {
    super(message)
    this.name = 'DshRpcError'
    this.code = code
    this.details = details
    this.method = method
  }
}

export function normalizeBaseUrl(value = 'http://127.0.0.1:3080') {
  let url
  try {
    url = new URL(value)
  } catch (error) {
    throw new DshRpcError(`Invalid DSH_WEB_URL: ${String(error)}`, { code: 'invalid-base-url' })
  }
  if (url.protocol !== 'http:') {
    throw new DshRpcError('DSH_WEB_URL must use http:// on loopback', { code: 'unsafe-base-url' })
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new DshRpcError('DSH_WEB_URL must resolve to 127.0.0.1, localhost, or ::1', { code: 'unsafe-base-url' })
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new DshRpcError('DSH_WEB_URL must not contain credentials, a query, or a fragment', { code: 'unsafe-base-url' })
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new DshRpcError('DSH_WEB_URL must not contain a path', { code: 'unsafe-base-url' })
  }
  return new URL(url.origin)
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function textFromContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

export function summarizeHistoryValue(value) {
  const entries = Array.isArray(value?.events) ? value.events : []
  let lastSeq = -1
  let finalResponse = ''
  let finishReason = null
  const messages = []

  for (const entry of entries) {
    const event = entry?.event
    if (Number.isInteger(event?.seq)) lastSeq = Math.max(lastSeq, event.seq)
    if (event?.type === 'assistant/message') {
      const text = textFromContent(event.data?.message?.content)
      if (text !== '') {
        finalResponse = text
        messages.push({ role: 'assistant', seq: event.seq, text })
      }
    } else if (event?.type === 'user/message') {
      const text = textFromContent(event.data?.message?.content)
      if (text !== '') messages.push({ role: 'user', seq: event.seq, text })
    } else if (event?.type === 'turn/end') {
      const reason = event.data?.reason
      finishReason = typeof reason === 'string' ? reason : reason?.kind ?? null
    }
  }

  return {
    lastSeq,
    finalResponse,
    finishReason,
    messages,
    hasMore: value?.hasMore === true,
    projections: value?.projections?.values ?? {},
  }
}

function publicSession(item) {
  const values = item?.projections?.values ?? {}
  return {
    sessionId: item.sessionId,
    title: typeof values.title === 'string' ? values.title : null,
    running: item.running === true,
    blank: item.blank === true,
    cwd: item.cwd,
    agentPreset: item.agentPreset,
    updatedAt: item.updatedAt,
    lastSeq: item?.projections?.asOfSeq,
    permissions: values.permissions?.currentValue,
  }
}

export class DshClient {
  constructor({ baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.timeoutMs = timeoutMs
  }

  async rpc(method, payload, { signal, timeoutMs = this.timeoutMs } = {}) {
    const rpcId = randomUUID()
    const response = await fetch(new URL(`/api/${method}`, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: combinedSignal(signal, timeoutMs),
    }).catch(error => {
      throw new DshRpcError(`Cannot reach DeepSeek Harness at ${this.baseUrl.origin}: ${String(error)}`, {
        code: 'connection-failed', method,
      })
    })

    if (!response.ok) {
      throw new DshRpcError(`DeepSeek Harness returned HTTP ${response.status} for ${method}`, {
        code: 'http-error', method, details: { status: response.status },
      })
    }

    const envelope = await response.json().catch(error => {
      throw new DshRpcError(`DeepSeek Harness returned invalid JSON for ${method}: ${String(error)}`, {
        code: 'invalid-response', method,
      })
    })
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId || typeof envelope.result?.ok !== 'boolean') {
      throw new DshRpcError(`DeepSeek Harness returned an invalid RPC envelope for ${method}`, {
        code: 'invalid-response', method,
      })
    }
    if (!envelope.result.ok) {
      const error = envelope.result.error ?? {}
      throw new DshRpcError(error.message ?? `DeepSeek Harness rejected ${method}`, {
        code: error.code ?? 'rpc-rejected', details: error.details, method,
      })
    }
    return envelope.result.value
  }

  async health(options) {
    const value = await this.rpc('host.describe', {}, options)
    return { reachable: true, baseUrl: this.baseUrl.origin, host: value }
  }

  async listSessions(options) {
    const value = await this.rpc('session.list', {}, options)
    return (value.items ?? []).map(publicSession)
  }

  async createSession({ cwd, workspaceId, sessionId, agentPreset } = {}, options) {
    const payload = {}
    if (cwd !== undefined) payload.cwd = cwd
    if (workspaceId !== undefined) payload.workspaceId = workspaceId
    if (sessionId !== undefined) payload.sessionId = sessionId
    if (agentPreset !== undefined) payload.agentPreset = agentPreset
    return this.rpc('session.create', payload, options)
  }

  async prompt(sessionId, text, { mode = 'queue', clientTimeZone, signal } = {}) {
    const payload = { sessionId, mode, content: [{ type: 'text', text }] }
    if (clientTimeZone !== undefined) payload.clientTimeZone = clientTimeZone
    return this.rpc('session.prompt', payload, { signal })
  }

  async cancel(sessionId, options) {
    return this.rpc('session.cancel', { sessionId }, options)
  }

  async history(sessionId, { beforeSeq, maxMessages = 8, signal } = {}) {
    const payload = { sessionId, maxMessages }
    if (beforeSeq !== undefined) payload.beforeSeq = beforeSeq
    const value = await this.rpc('session.history', payload, { signal })
    return summarizeHistoryValue(value)
  }

  webSocketUrl(path) {
    const url = new URL(path, this.baseUrl)
    url.protocol = 'ws:'
    return url
  }

  async wait(sessionId, { afterSeq = -1, timeoutMs = 30_000, signal } = {}) {
    if (!Number.isInteger(afterSeq) || afterSeq < -1) {
      throw new DshRpcError('afterSeq must be an integer greater than or equal to -1', { code: 'invalid-argument' })
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
      throw new DshRpcError('timeoutMs must be an integer from 100 to 300000', { code: 'invalid-argument' })
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('wait timeout')), timeoutMs)
    timer.unref?.()
    const activeSignal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    const sockets = []
    const recentEvents = []
    let lastSeq = afterSeq
    let outcome
    let settle
    const completed = new Promise(resolve => { settle = resolve })
    const finish = value => {
      if (outcome !== undefined) return
      outcome = value
      settle(value)
    }

    const handleEnvelope = envelope => {
      const frame = envelope?.payload
      if (frame?.sessionId !== sessionId) return
      if (frame.type === 'session/event') {
        const seq = frame.event?.seq
        if (Number.isInteger(seq) && seq > afterSeq) {
          lastSeq = Math.max(lastSeq, seq)
          recentEvents.push({ seq, type: frame.event.type })
          if (recentEvents.length > 40) recentEvents.shift()
        }
      } else if (frame.type === 'approval/requested') {
        finish({ state: 'needs_user_action', kind: 'approval', toolName: frame.toolName, lastSeq })
      } else if (frame.type === 'question/requested') {
        finish({ state: 'needs_user_action', kind: 'question', questions: frame.questions, lastSeq })
      } else if (frame.type === 'host/session-status' && frame.running === false) {
        finish({ state: 'completed', lastSeq })
      } else if (frame.type === 'host/agent-error') {
        finish({ state: 'error', message: frame.message, lastSeq })
      }
    }

    const open = path => new Promise((resolve, reject) => {
      const socket = new WebSocket(this.webSocketUrl(path))
      sockets.push(socket)
      const onAbort = () => socket.close()
      activeSignal.addEventListener('abort', onAbort, { once: true })
      socket.addEventListener('open', () => resolve(socket), { once: true })
      socket.addEventListener('message', event => {
        try { handleEnvelope(JSON.parse(String(event.data))) } catch { /* malformed frames are ignored */ }
      })
      socket.addEventListener('error', () => reject(new DshRpcError(`WebSocket connection failed for ${path}`, {
        code: 'stream-connection-failed',
      })), { once: true })
      socket.addEventListener('close', () => activeSignal.removeEventListener('abort', onAbort), { once: true })
    })

    try {
      await Promise.all([open('/api/events.mux'), open('/api/events.host')])
      const sessions = await this.listSessions({ signal: activeSignal })
      const current = sessions.find(item => item.sessionId === sessionId)
      if (current === undefined) throw new DshRpcError(`Unknown DeepSeek Harness session: ${sessionId}`, { code: 'session-not-found' })
      if (!current.running) finish({ state: 'completed', lastSeq: Math.max(lastSeq, current.lastSeq ?? -1) })

      const timeoutResult = new Promise(resolve => {
        activeSignal.addEventListener('abort', () => resolve({ state: 'timeout', lastSeq }), { once: true })
      })
      const result = await Promise.race([completed, timeoutResult])
      const history = await this.history(sessionId, { maxMessages: 8, signal })
      return { ...result, lastSeq: Math.max(result.lastSeq ?? -1, history.lastSeq), recentEvents, ...history }
    } finally {
      clearTimeout(timer)
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
      }
    }
  }
}
