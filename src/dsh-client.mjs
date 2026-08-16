import { randomUUID } from 'node:crypto'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_HISTORY_CHAR_LIMIT = 30_000
const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const MAX_ATTACHMENT_ID_CHARS = 512
const MAX_ATTACHMENT_NAME_CHARS = 256
const USER_ACTION_SETTLE_DELAY_MS = 25
export const PERMISSION_PRESETS = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

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

export function parsePermissionPreset(value) {
  if (!PERMISSION_PRESETS.includes(value)) {
    throw new DshRpcError(`permission must be one of: ${PERMISSION_PRESETS.join(', ')}`, {
      code: 'invalid-permission', details: { value },
    })
  }
  return value
}

function requireWireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DshRpcError(`${name} must be a non-empty string`, { code: 'invalid-argument' })
  }
  return value
}

function textFromContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

function publicImageAttachmentRef(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.attachmentId !== 'string' || value.attachmentId.trim() === ''
      || value.attachmentId.length > MAX_ATTACHMENT_ID_CHARS) return null
  if (!IMAGE_MEDIA_TYPES.has(value.mediaType)) return null
  if (!Number.isInteger(value.bytes) || value.bytes < 1
      || !Number.isInteger(value.width) || value.width < 1
      || !Number.isInteger(value.height) || value.height < 1) return null
  const cleanName = typeof value.name === 'string'
    ? value.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '\uFFFD')
    : ''
  const name = cleanName !== ''
    ? cleanName.slice(0, MAX_ATTACHMENT_NAME_CHARS)
    : undefined
  return {
    attachmentId: value.attachmentId,
    mediaType: value.mediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    ...(name === undefined ? {} : { name, nameTruncated: cleanName.length > name.length }),
  }
}

function collectImageAttachments(node, output, { seq, eventType }, depth = 0) {
  if (depth > 12 || node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectImageAttachments(item, output, { seq, eventType }, depth + 1)
    return
  }
  if (node.type === 'image') {
    const attachment = publicImageAttachmentRef(node.attachment)
    if (attachment !== null && !output.has(attachment.attachmentId)) {
      output.set(attachment.attachmentId, { ...attachment, seq, eventType })
    }
  }
  for (const value of Object.values(node)) {
    collectImageAttachments(value, output, { seq, eventType }, depth + 1)
  }
}

function boundedNewestMessages(messages, maxChars) {
  let remaining = maxChars
  let truncated = false
  const kept = []
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = messages[index]
    let text = message.text
    if (text.length > remaining) {
      text = `${text.slice(0, Math.max(0, remaining - 1))}…`
      truncated = true
    }
    kept.unshift({ ...message, text })
    remaining -= text.length
  }
  if (kept.length < messages.length) truncated = true
  return { messages: kept, truncated }
}

function compactToolEvent(event, maxChars) {
  const data = event.data ?? {}
  if (event.type === 'tool/call') {
    const raw = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? null)
    const truncated = raw.length > maxChars
    return {
      seq: event.seq, type: 'call', turn: data.turn, step: data.step, callId: data.callId,
      name: data.name, arguments: truncated ? `${raw.slice(0, Math.max(0, maxChars - 1))}…` : raw,
      truncated,
    }
  }
  if (event.type === 'tool/result') {
    const raw = typeof data.message === 'string' ? data.message : textFromContent(data.message?.content)
    const truncated = raw.length > maxChars
    return {
      seq: event.seq, type: 'result', turn: data.turn, step: data.step,
      text: truncated ? `${raw.slice(0, Math.max(0, maxChars - 1))}…` : raw,
      ...(data.error === undefined ? {} : { error: data.error }),
      truncated,
    }
  }
  return null
}

export function summarizeHistoryValue(value, {
  maxChars = DEFAULT_HISTORY_CHAR_LIMIT, includeTools = false, maxToolEvents = 20, maxToolChars = 2_000,
  afterSeq = -1,
} = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new DshRpcError('maxChars must be a positive integer', { code: 'invalid-argument' })
  if (!Number.isInteger(afterSeq) || afterSeq < -1) throw new DshRpcError('afterSeq must be at least -1', { code: 'invalid-argument' })
  const entries = Array.isArray(value?.events) ? value.events : []
  let firstSeq = -1
  let lastSeq = -1
  let finishReason = null
  const rawMessages = []
  const rawToolEvents = []
  const imageAttachments = new Map()

  for (const entry of entries) {
    const event = entry?.event
    if (Number.isInteger(event?.seq)) {
      firstSeq = firstSeq === -1 ? event.seq : Math.min(firstSeq, event.seq)
      lastSeq = Math.max(lastSeq, event.seq)
    }
    const inRequestedRange = Number.isInteger(event?.seq) && event.seq > afterSeq
    if (inRequestedRange) {
      collectImageAttachments(event?.data, imageAttachments, { seq: event.seq, eventType: event.type })
    }
    if (inRequestedRange && event?.type === 'assistant/message') {
      const text = textFromContent(event.data?.message?.content)
      if (text !== '') rawMessages.push({ role: 'assistant', seq: event.seq, text })
    } else if (inRequestedRange && event?.type === 'user/message') {
      const text = textFromContent(event.data?.content ?? event.data?.message?.content)
      if (text !== '') rawMessages.push({ role: 'user', seq: event.seq, text })
    } else if (inRequestedRange && event?.type === 'turn/end') {
      const reason = event.data?.reason
      finishReason = typeof reason === 'string' ? reason : reason?.kind ?? null
    }
    if (inRequestedRange && includeTools && (event?.type === 'tool/call' || event?.type === 'tool/result')) {
      const summary = compactToolEvent(event, maxToolChars)
      if (summary !== null) rawToolEvents.push(summary)
    }
  }

  const bounded = boundedNewestMessages(rawMessages, maxChars)
  const finalResponse = bounded.messages.findLast(message => message.role === 'assistant')?.text ?? ''
  const toolEvents = rawToolEvents.slice(-maxToolEvents)
  const hasMore = value?.hasMore === true

  return {
    firstSeq,
    lastSeq,
    nextBeforeSeq: hasMore && firstSeq >= 0 ? firstSeq : null,
    finalResponse,
    finishReason,
    messages: bounded.messages,
    attachments: [...imageAttachments.values()],
    messagesTruncated: bounded.truncated,
    filteredAfterSeq: afterSeq,
    ...(includeTools ? { toolEvents, toolEventsTruncated: toolEvents.length < rawToolEvents.length } : {}),
    hasMore,
    projections: value?.projections?.values ?? {},
  }
}

export function mergeWaitResult(result, recentEvents, history) {
  return {
    ...result,
    recentEvents,
    ...history,
    lastSeq: Math.max(result?.lastSeq ?? -1, history?.lastSeq ?? -1),
  }
}

export function waitAbortResult(externalSignal, lastSeq) {
  return { state: externalSignal?.aborted === true ? 'cancelled' : 'timeout', lastSeq }
}

export function userActionFromEnvelope(envelope, sessionId, lastSeq, observedAt = Date.now()) {
  const frame = envelope?.payload
  if (frame?.sessionId !== sessionId) return null
  if (frame.type === 'approval/requested') {
    return {
      state: 'needs_user_action', kind: 'approval', toolName: frame.toolName, lastSeq,
      approval: {
        rpcId: envelope.rpcId, approvalId: frame.approvalId, toolName: frame.toolName,
        ...frame.callId === undefined ? {} : { callId: frame.callId },
        ...frame.reason === undefined ? {} : { reason: frame.reason },
        observedAt, mayBeStale: true,
      },
    }
  }
  if (frame.type === 'question/requested') {
    return {
      state: 'needs_user_action', kind: 'question', questions: frame.questions, lastSeq,
      question: { rpcId: envelope.rpcId, questions: frame.questions, observedAt, mayBeStale: true },
    }
  }
  return null
}

export function promptProgressFromHistory(value, promptRpcId) {
  let promptSeq = -1
  let lastSeq = -1
  let completed = false
  for (const entry of Array.isArray(value?.events) ? value.events : []) {
    const event = entry?.event
    if (!Number.isInteger(event?.seq)) continue
    lastSeq = Math.max(lastSeq, event.seq)
    if (event.type === 'user/message' && event.data?.source?.rpcId === promptRpcId) {
      promptSeq = event.seq
      completed = false
    } else if (promptSeq >= 0 && event.type === 'turn/end' && event.seq > promptSeq) {
      completed = true
    }
  }
  return { seen: promptSeq >= 0, completed, promptSeq, lastSeq }
}

function publicSession(item) {
  const values = item?.projections?.values ?? {}
  return {
    sessionId: item.sessionId,
    parentSessionId: item.parentSessionId ?? null,
    origin: item.origin ?? null,
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

  async rpc(method, payload, { signal, timeoutMs = this.timeoutMs, includeRpcId = false } = {}) {
    const rpcId = randomUUID()
    const response = await fetch(new URL(`/api/${method}`, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: combinedSignal(signal, timeoutMs),
    }).catch(error => {
      if (signal?.aborted === true) {
        throw new DshRpcError(`DeepSeek Harness request was cancelled: ${method}`, {
          code: 'cancelled', method,
        })
      }
      if (error?.name === 'TimeoutError') {
        throw new DshRpcError(`DeepSeek Harness request timed out: ${method}`, {
          code: 'timeout', method,
        })
      }
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
    return includeRpcId ? { rpcId, value: envelope.result.value } : envelope.result.value
  }

  async health(options) {
    const value = await this.rpc('host.describe', {}, options)
    return { reachable: true, baseUrl: this.baseUrl.origin, host: value }
  }

  async listSessions(options) {
    const value = await this.rpc('session.list', {}, options)
    return (value.items ?? []).map(publicSession)
  }

  async getSession(sessionId, options) {
    const id = requireWireString(sessionId, 'sessionId')
    const session = (await this.listSessions(options)).find(item => item.sessionId === id)
    if (session === undefined) throw new DshRpcError(`Unknown DeepSeek Harness session: ${id}`, { code: 'session-not-found' })
    return session
  }

  async searchSessions(query, options) {
    try {
      const value = await this.rpc('session.search', { query: requireWireString(query, 'query') }, options)
      return { available: true, matches: value.items ?? [], hasMore: value.hasMore === true }
    } catch (error) {
      if (error instanceof DshRpcError && /search is disabled/i.test(error.message)) {
        throw new DshRpcError('Session search is disabled by this DSH deployment', {
          code: 'search-disabled', method: 'session.search', details: error.details,
        })
      }
      throw error
    }
  }

  async listWorkspaces(options) {
    const value = await this.rpc('workspace.list', {}, options)
    return {
      workspaces: (value.items ?? []).map(item => ({
        workspaceId: item.workspaceId, path: item.path, title: item.title ?? null,
        sessionIds: item.sessionIds ?? [], createdAt: item.createdAt, updatedAt: item.updatedAt,
      })),
      archivedSessionIds: value.archivedSessionIds ?? [],
    }
  }

  async getAttachment(sessionId, attachmentId, {
    signal, maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
  } = {}) {
    const id = requireWireString(attachmentId, 'attachmentId')
    if (id.length > MAX_ATTACHMENT_ID_CHARS) {
      throw new DshRpcError('attachmentId is too long', { code: 'invalid-argument' })
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new DshRpcError('maxBytes must be a positive integer', { code: 'invalid-argument' })
    }
    const value = await this.rpc('session.attachment', {
      sessionId: requireWireString(sessionId, 'sessionId'), attachmentId: id,
    }, { signal })
    const attachment = publicImageAttachmentRef(value?.attachment)
    if (attachment === null || attachment.attachmentId !== id || typeof value?.data !== 'string'
        || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) {
      throw new DshRpcError('DSH returned invalid image attachment data', {
        code: 'attachment-data-invalid', method: 'session.attachment', details: { attachmentId: id },
      })
    }
    const decoded = Buffer.from(value.data, 'base64')
    const decodedBytes = decoded.byteLength
    if (decoded.toString('base64') !== value.data) {
      throw new DshRpcError('DSH returned non-canonical image attachment data', {
        code: 'attachment-data-invalid', method: 'session.attachment', details: { attachmentId: id },
      })
    }
    if (decodedBytes !== attachment.bytes) {
      throw new DshRpcError('DSH attachment byte count does not match its metadata', {
        code: 'attachment-data-invalid', method: 'session.attachment',
        details: { attachmentId: id, declaredBytes: attachment.bytes, decodedBytes },
      })
    }
    if (decodedBytes > maxBytes) {
      throw new DshRpcError('DSH attachment exceeds this bridge instance\'s image limit', {
        code: 'attachment-too-large', method: 'session.attachment',
        details: { attachmentId: id, bytes: decodedBytes, maxBytes },
      })
    }
    return { attachment, data: value.data }
  }

  async createWorkspace(path, options) {
    const value = await this.rpc('workspace.create', {
      path: requireWireString(path, 'path'),
    }, options)
    const workspace = value.workspace ?? {}
    return {
      created: value.created === true,
      workspace: {
        workspaceId: workspace.workspaceId,
        path: workspace.path,
        title: workspace.title ?? null,
        sessionIds: workspace.sessionIds ?? [],
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      },
    }
  }

  async listAgentPresets(options) {
    const value = await this.rpc('agentPreset.list', {}, options)
    return {
      presets: (value.presets ?? []).map(item => ({
        id: item.id, trust: item.trust, isDefault: item.isDefault === true,
        name: item.name ?? null, description: item.description ?? null, broken: item.broken ?? null,
      })),
      authorable: value.authorable === true,
      hasDocument: value.hasDocument === true,
    }
  }

  async getModels(sessionId, options) {
    return this.rpc('session.models', { sessionId: requireWireString(sessionId, 'sessionId') }, options)
  }

  async createSession({ cwd, workspaceId, sessionId, agentPreset } = {}, options) {
    const payload = {}
    if (cwd !== undefined) payload.cwd = cwd
    if (workspaceId !== undefined) payload.workspaceId = workspaceId
    if (sessionId !== undefined) payload.sessionId = sessionId
    if (agentPreset !== undefined) payload.agentPreset = agentPreset
    return this.rpc('session.create', payload, options)
  }

  async renameSession(sessionId, title, options) {
    return this.rpc('session.rename', {
      sessionId: requireWireString(sessionId, 'sessionId'), title: requireWireString(title, 'title'),
    }, options)
  }

  async forkSession(sessionId, { atSeq, signal } = {}) {
    const payload = { sessionId: requireWireString(sessionId, 'sessionId') }
    if (atSeq !== undefined) payload.atSeq = atSeq
    return this.rpc('session.fork', payload, { signal })
  }

  async setPermission(sessionId, preset, options) {
    const permission = parsePermissionPreset(preset)
    const value = await this.rpc('commands/execute', {
      args: { agentId: requireWireString(sessionId, 'sessionId'), line: `/permission ${permission}` },
    }, options)
    if (value?.result?.kind !== 'success') {
      throw new DshRpcError(value?.result?.text ?? 'DSH did not accept the /permission command', {
        code: 'permission-command-failed', method: 'commands/execute', details: { sessionId, permission },
      })
    }
    return {
      sessionId,
      permission,
      commandId: value.commandId,
      sourceEventSeq: value.result.sourceEventSeq,
    }
  }

  async prompt(sessionId, text, { mode = 'queue', clientTimeZone, signal } = {}) {
    const payload = { sessionId, mode, content: [{ type: 'text', text }] }
    if (clientTimeZone !== undefined) payload.clientTimeZone = clientTimeZone
    const result = await this.rpc('session.prompt', payload, { signal, includeRpcId: true })
    return { ...result.value, promptRpcId: result.rpcId }
  }

  async promptProgress(sessionId, promptRpcId, options) {
    const value = await this.rpc('session.history', {
      sessionId: requireWireString(sessionId, 'sessionId'), maxMessages: 20,
    }, options)
    return promptProgressFromHistory(value, requireWireString(promptRpcId, 'promptRpcId'))
  }

  async cancel(sessionId, options) {
    return this.rpc('session.cancel', { sessionId }, options)
  }

  async postResponse(rpcId, result, { signal, timeoutMs = this.timeoutMs } = {}) {
    requireWireString(rpcId, 'rpcId')
    const response = await fetch(new URL('/api/respond', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId, result }),
      signal: combinedSignal(signal, timeoutMs),
    }).catch(error => {
      const code = signal?.aborted === true ? 'cancelled' : error?.name === 'TimeoutError' ? 'timeout' : 'connection-failed'
      throw new DshRpcError(`Cannot answer DeepSeek Harness request: ${String(error)}`, {
        code, method: 'respond',
      })
    })
    if (!response.ok) {
      throw new DshRpcError(`DeepSeek Harness returned HTTP ${response.status} for response`, {
        code: 'http-error', method: 'respond', details: { status: response.status },
      })
    }
    const receipt = await response.json().catch(error => {
      throw new DshRpcError(`DeepSeek Harness returned an invalid response receipt: ${String(error)}`, {
        code: 'invalid-response', method: 'respond',
      })
    })
    if (receipt?.accepted === true) return { accepted: true, state: 'resolved' }
    if (receipt?.reason === 'not-pending') return { accepted: false, state: 'already_resolved' }
    throw new DshRpcError(`DeepSeek Harness rejected the response: ${String(receipt?.reason ?? 'unknown')}`, {
      code: 'response-rejected', method: 'respond', details: { reason: receipt?.reason },
    })
  }

  async respondApproval({ sessionId, rpcId, approvalId, outcome }, options) {
    requireWireString(sessionId, 'sessionId')
    requireWireString(approvalId, 'approvalId')
    if (outcome !== 'allowed-once' && outcome !== 'rejected') {
      throw new DshRpcError('outcome must be allowed-once or rejected', { code: 'invalid-argument' })
    }
    return {
      ...(await this.postResponse(rpcId, {
        ok: true, value: { sessionId, approvalId, outcome },
      }, options)),
      outcome,
    }
  }

  async respondQuestion({ sessionId, rpcId, answers }, options) {
    requireWireString(sessionId, 'sessionId')
    if (!Array.isArray(answers) || answers.length === 0) {
      throw new DshRpcError('answers must be a non-empty array', { code: 'invalid-argument' })
    }
    const ids = new Set()
    const normalized = answers.map(answer => {
      const id = requireWireString(answer?.id, 'answer.id')
      if (ids.has(id)) throw new DshRpcError(`duplicate answer id: ${id}`, { code: 'invalid-argument' })
      ids.add(id)
      if (!Array.isArray(answer.selected) || !answer.selected.every(item => typeof item === 'string')) {
        throw new DshRpcError('answer.selected must be an array of strings', { code: 'invalid-argument' })
      }
      const selected = [...new Set(answer.selected)]
      const custom = answer.custom === undefined ? undefined : requireWireString(answer.custom, 'answer.custom').trim()
      if (selected.length > 0 && custom !== undefined) {
        throw new DshRpcError('answer.selected and answer.custom are mutually exclusive', { code: 'invalid-argument' })
      }
      return { id, selected, ...(custom === undefined ? {} : { custom }) }
    })
    return this.postResponse(rpcId, {
      ok: true, value: { sessionId, answer: { answers: normalized } },
    }, options)
  }

  async cancelQuestion({ rpcId, message = 'Cancelled by user' }, options) {
    return this.postResponse(rpcId, {
      ok: false, error: { code: 'cancelled', message: requireWireString(message, 'message'), details: {} },
    }, options)
  }

  async history(sessionId, {
    beforeSeq, maxMessages = 8, maxChars = DEFAULT_HISTORY_CHAR_LIMIT, includeTools = false,
    maxToolEvents = 20, maxToolChars = 2_000, afterSeq = -1, signal,
  } = {}) {
    const payload = { sessionId, maxMessages }
    if (beforeSeq !== undefined) payload.beforeSeq = beforeSeq
    const value = await this.rpc('session.history', payload, { signal })
    return summarizeHistoryValue(value, { maxChars, includeTools, maxToolEvents, maxToolChars, afterSeq })
  }

  webSocketUrl(path) {
    const url = new URL(path, this.baseUrl)
    url.protocol = 'ws:'
    return url
  }

  async wait(sessionId, { afterSeq = -1, promptRpcId, timeoutMs = 30_000, signal } = {}) {
    if (!Number.isInteger(afterSeq) || afterSeq < -1) {
      throw new DshRpcError('afterSeq must be an integer greater than or equal to -1', { code: 'invalid-argument' })
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
      throw new DshRpcError('timeoutMs must be an integer from 100 to 300000', { code: 'invalid-argument' })
    }
    if (promptRpcId !== undefined) requireWireString(promptRpcId, 'promptRpcId')
    if (signal?.aborted === true) return { state: 'cancelled', lastSeq: afterSeq, recentEvents: [] }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('wait timeout')), timeoutMs)
    timer.unref?.()
    const activeSignal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    const sockets = []
    const recentEvents = []
    let lastSeq = afterSeq
    let outcome
    let settle
    let shuttingDown = false
    let pendingUserAction = null
    let pendingUserActionTimer = null
    let targetPromptSeen = promptRpcId === undefined
    let targetPromptSeq = -1
    const completed = new Promise(resolve => { settle = resolve })
    const finish = value => {
      if (outcome !== undefined) return
      outcome = value
      settle(value)
    }
    const clearPendingUserAction = () => {
      if (pendingUserActionTimer !== null) clearTimeout(pendingUserActionTimer)
      pendingUserActionTimer = null
      pendingUserAction = null
    }
    const scheduleUserAction = value => {
      clearPendingUserAction()
      pendingUserAction = value
      pendingUserActionTimer = setTimeout(() => finish(pendingUserAction), USER_ACTION_SETTLE_DELAY_MS)
      pendingUserActionTimer.unref?.()
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
        if (frame.event?.type === 'user/message' && frame.event.data?.source?.rpcId === promptRpcId) {
          targetPromptSeen = true
          targetPromptSeq = frame.event.seq
        } else if (promptRpcId !== undefined && targetPromptSeen && frame.event?.type === 'turn/end' && frame.event.seq > targetPromptSeq) {
          clearPendingUserAction()
          finish({ state: 'completed', lastSeq: Math.max(lastSeq, frame.event.seq), promptRpcId })
        }
      } else if (frame.type === 'approval/requested' || frame.type === 'question/requested') {
        const action = userActionFromEnvelope(envelope, sessionId, lastSeq)
        if (action !== null) scheduleUserAction(action)
      } else if (frame.type === 'approval/resolved') {
        if (pendingUserAction?.kind === 'approval' && pendingUserAction.approval.approvalId === frame.approvalId) {
          clearPendingUserAction()
        }
      } else if (frame.type === 'question/resolved') {
        if (pendingUserAction?.kind === 'question' && pendingUserAction.question.rpcId === frame.questionRpcId) {
          clearPendingUserAction()
        }
      } else if (frame.type === 'host/session-status' && frame.running === false && (promptRpcId === undefined || targetPromptSeen)) {
        clearPendingUserAction()
        finish({ state: 'completed', lastSeq })
      } else if (frame.type === 'host/agent-error') {
        clearPendingUserAction()
        finish({ state: 'error', message: frame.message, lastSeq })
      }
    }

    const open = path => new Promise((resolve, reject) => {
      const socket = new WebSocket(this.webSocketUrl(path))
      let opened = false
      sockets.push(socket)
      const onAbort = () => socket.close()
      activeSignal.addEventListener('abort', onAbort, { once: true })
      socket.addEventListener('open', () => {
        opened = true
        resolve(socket)
      }, { once: true })
      socket.addEventListener('message', event => {
        try { handleEnvelope(JSON.parse(String(event.data))) } catch { /* malformed frames are ignored */ }
      })
      socket.addEventListener('error', () => {
        const error = new DshRpcError(`WebSocket connection failed for ${path}`, { code: 'stream-connection-failed' })
        if (opened) finish({ state: 'error', code: error.code, message: error.message, lastSeq })
        else reject(error)
      })
      socket.addEventListener('close', () => {
        activeSignal.removeEventListener('abort', onAbort)
        if (!opened && !activeSignal.aborted) {
          reject(new DshRpcError(`WebSocket closed before opening: ${path}`, { code: 'stream-connection-failed' }))
        } else if (opened && !shuttingDown && !activeSignal.aborted) {
          finish({ state: 'error', code: 'stream-disconnected', message: `WebSocket disconnected: ${path}`, lastSeq })
        }
      }, { once: true })
    })

    try {
      const setupAbort = new Promise(resolveSetup => {
        activeSignal.addEventListener('abort', () => resolveSetup(waitAbortResult(signal, lastSeq)), { once: true })
      })
      const setup = await Promise.race([Promise.all([open('/api/events.mux'), open('/api/events.host')]), setupAbort])
      if (!Array.isArray(setup)) return { ...setup, recentEvents }
      const [sessions, initialPrompt] = await Promise.all([
        this.listSessions({ signal: activeSignal }),
        promptRpcId === undefined
          ? Promise.resolve(null)
          : this.promptProgress(sessionId, promptRpcId, { signal: activeSignal }),
      ])
      const current = sessions.find(item => item.sessionId === sessionId)
      if (current === undefined) throw new DshRpcError(`Unknown DeepSeek Harness session: ${sessionId}`, { code: 'session-not-found' })
      if (initialPrompt !== null) {
        targetPromptSeen = initialPrompt.seen
        targetPromptSeq = initialPrompt.promptSeq
        lastSeq = Math.max(lastSeq, initialPrompt.lastSeq)
        if (initialPrompt.completed) finish({ state: 'completed', lastSeq, promptRpcId })
      }
      if (!current.running && promptRpcId === undefined) finish({ state: 'completed', lastSeq: Math.max(lastSeq, current.lastSeq ?? -1) })

      const timeoutResult = new Promise(resolve => {
        activeSignal.addEventListener('abort', () => resolve(waitAbortResult(signal, lastSeq)), { once: true })
      })
      const result = await Promise.race([completed, timeoutResult])
      if (result.state === 'cancelled') return { ...result, recentEvents }
      const history = await this.history(sessionId, { maxMessages: 8, afterSeq, signal })
      return mergeWaitResult(result, recentEvents, history)
    } finally {
      shuttingDown = true
      clearPendingUserAction()
      clearTimeout(timer)
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
      }
    }
  }
}
