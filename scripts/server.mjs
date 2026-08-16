#!/usr/bin/env node

import { createInterface } from 'node:readline'
import { DshClient, DshRpcError, parsePermissionPreset } from '../src/dsh-client.mjs'

const SERVER_INFO = { name: 'deepseek-harness-bridge', version: '0.2.0' }
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])
const controllers = new Map()
const client = new DshClient()

function booleanEnv(name, fallback = false) {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be true or false`)
}

const APPROVAL_RESPONSES_ENABLED = booleanEnv('DSH_ENABLE_APPROVAL_RESPONSES')
const DANGER_FULL_ACCESS_ENABLED = booleanEnv('DSH_ALLOW_DANGER_FULL_ACCESS')
const DEFAULT_PERMISSION = parsePermissionPreset(process.env.DSH_DEFAULT_PERMISSION ?? 'workspace-write')
if (DEFAULT_PERMISSION === 'danger-full-access' && !DANGER_FULL_ACCESS_ENABLED) {
  throw new Error('DSH_DEFAULT_PERMISSION=danger-full-access requires DSH_ALLOW_DANGER_FULL_ACCESS=true')
}

function bridgePolicy() {
  return {
    defaultPermission: DEFAULT_PERMISSION,
    dangerFullAccessEnabled: DANGER_FULL_ACCESS_ENABLED,
    approvalResponsesEnabled: APPROVAL_RESPONSES_ENABLED,
  }
}

const tools = [
  {
    name: 'dsh_health',
    description: 'Check whether the existing loopback DeepSeek Harness Web runtime is reachable.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_list_sessions',
    description: 'List sessions visible in the existing DeepSeek Harness Web UI.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_start_task',
    description: 'Create a visible DeepSeek Harness session and submit a task. This invokes the configured DeepSeek model and may incur usage.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', minLength: 1, description: 'Task sent to DeepSeek Harness.' },
        cwd: { type: 'string', minLength: 1, description: 'Absolute workspace path used by DSH.' },
        workspace_id: { type: 'string', minLength: 1, description: 'Existing DSH workspace id; mutually exclusive with cwd.' },
        agent_preset: { type: 'string', minLength: 1, default: 'standard' },
        session_id: { type: 'string', minLength: 1, description: 'Optional caller-supplied session id.' },
        permission: {
          type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'],
          description: 'Session permission set before the task is submitted. Defaults to DSH_DEFAULT_PERMISSION. danger-full-access also requires the operator opt-in environment flag.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'dsh_set_permission',
    description: 'Change one existing DSH session permission through the host /permission command. danger-full-access is rejected unless the operator enabled it in plugin configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1 },
        permission: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
      },
      required: ['session_id', 'permission'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_send',
    description: 'Continue a visible DSH session. Queue starts a later turn; steer guides a currently running turn.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1 },
        message: { type: 'string', minLength: 1 },
        mode: { type: 'string', enum: ['queue', 'steer'], default: 'queue' },
      },
      required: ['session_id', 'message'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'dsh_wait',
    description: 'Wait for DSH progress or completion. Permission and question prompts are returned for the user to handle in the DSH Web UI; this tool never auto-approves them.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1 },
        after_seq: { type: 'integer', minimum: -1, default: -1 },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 300000, default: 30000 },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_answer_approval',
    description: 'Allow once or reject one exact pending DSH approval. Disabled by default. Use only after the user explicitly decides; otherwise handle the request in DSH Web.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1 },
        rpc_id: { type: 'string', minLength: 1 },
        approval_id: { type: 'string', minLength: 1 },
        decision: { type: 'string', enum: ['allow_once', 'reject'] },
      },
      required: ['session_id', 'rpc_id', 'approval_id', 'decision'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_history',
    description: 'Read a compact message-level summary of one DSH session without returning token-stream chunks.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1 },
        before_seq: { type: 'integer', minimum: 0 },
        max_messages: { type: 'integer', minimum: 1, maximum: 50, default: 8 },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_cancel',
    description: 'Cancel only the currently active turn in a DSH session; queued work remains in DSH.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string', minLength: 1 } },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
]

function requireString(args, key) {
  const value = args?.[key]
  if (typeof value !== 'string' || value.trim() === '') throw new DshRpcError(`${key} must be a non-empty string`, { code: 'invalid-argument' })
  return value
}

function optionalString(args, key) {
  const value = args?.[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new DshRpcError(`${key} must be a non-empty string`, { code: 'invalid-argument' })
  return value
}

function optionalInteger(args, key, fallback, minimum, maximum) {
  const value = args?.[key] ?? fallback
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new DshRpcError(`${key} must be an integer from ${minimum} to ${maximum}`, { code: 'invalid-argument' })
  }
  return value
}

function permissionFrom(args, key, fallback) {
  return parsePermissionPreset(args?.[key] ?? fallback)
}

function ensurePermissionEnabled(permission) {
  if (permission === 'danger-full-access' && !DANGER_FULL_ACCESS_ENABLED) {
    throw new DshRpcError('danger-full-access is disabled by the bridge operator', {
      code: 'danger-full-access-disabled',
      details: { requiredEnvironment: 'DSH_ALLOW_DANGER_FULL_ACCESS=true' },
    })
  }
  return permission
}

async function callTool(name, args, signal) {
  switch (name) {
    case 'dsh_health':
      return { ...(await client.health({ signal })), bridgePolicy: bridgePolicy() }
    case 'dsh_list_sessions':
      return { sessions: await client.listSessions({ signal }) }
    case 'dsh_start_task': {
      const task = requireString(args, 'task')
      const cwd = optionalString(args, 'cwd')
      const workspaceId = optionalString(args, 'workspace_id')
      const permission = ensurePermissionEnabled(permissionFrom(args, 'permission', DEFAULT_PERMISSION))
      if (cwd !== undefined && workspaceId !== undefined) throw new DshRpcError('cwd and workspace_id are mutually exclusive', { code: 'invalid-argument' })
      const created = await client.createSession({
        cwd,
        workspaceId,
        sessionId: optionalString(args, 'session_id'),
        agentPreset: optionalString(args, 'agent_preset') ?? 'standard',
      }, { signal })
      try {
        await client.setPermission(created.sessionId, permission, { signal })
        const accepted = await client.prompt(created.sessionId, task, { mode: 'queue', signal })
        return { ...created, permission, accepted: accepted.accepted === true, visibleInWebUi: true }
      } catch (error) {
        if (error instanceof DshRpcError) error.details = { ...error.details, createdSessionId: created.sessionId }
        throw error
      }
    }
    case 'dsh_set_permission': {
      const sessionId = requireString(args, 'session_id')
      const permission = ensurePermissionEnabled(permissionFrom(args, 'permission'))
      return client.setPermission(sessionId, permission, { signal })
    }
    case 'dsh_send': {
      const sessionId = requireString(args, 'session_id')
      const message = requireString(args, 'message')
      const mode = args?.mode ?? 'queue'
      if (mode !== 'queue' && mode !== 'steer') throw new DshRpcError('mode must be queue or steer', { code: 'invalid-argument' })
      return { sessionId, ...(await client.prompt(sessionId, message, { mode, signal })) }
    }
    case 'dsh_wait': {
      const result = await client.wait(requireString(args, 'session_id'), {
        afterSeq: optionalInteger(args, 'after_seq', -1, -1, Number.MAX_SAFE_INTEGER),
        timeoutMs: optionalInteger(args, 'timeout_ms', 30_000, 100, 300_000),
        signal,
      })
      if (result.kind === 'approval' && result.approval !== undefined) {
        result.approval.responseEnabled = APPROVAL_RESPONSES_ENABLED
        result.approval.responseMode = APPROVAL_RESPONSES_ENABLED ? 'mcp-or-web-ui' : 'web-ui-only'
      }
      return result
    }
    case 'dsh_answer_approval': {
      if (!APPROVAL_RESPONSES_ENABLED) {
        throw new DshRpcError('MCP approval responses are disabled; answer in DSH Web instead', {
          code: 'approval-responses-disabled',
          details: { requiredEnvironment: 'DSH_ENABLE_APPROVAL_RESPONSES=true' },
        })
      }
      const decision = requireString(args, 'decision')
      if (decision !== 'allow_once' && decision !== 'reject') {
        throw new DshRpcError('decision must be allow_once or reject', { code: 'invalid-argument' })
      }
      return client.respondApproval({
        sessionId: requireString(args, 'session_id'),
        rpcId: requireString(args, 'rpc_id'),
        approvalId: requireString(args, 'approval_id'),
        outcome: decision === 'allow_once' ? 'allowed-once' : 'rejected',
      }, { signal })
    }
    case 'dsh_history':
      return client.history(requireString(args, 'session_id'), {
        beforeSeq: args?.before_seq === undefined ? undefined : optionalInteger(args, 'before_seq', 0, 0, Number.MAX_SAFE_INTEGER),
        maxMessages: optionalInteger(args, 'max_messages', 8, 1, 50),
        signal,
      })
    case 'dsh_cancel': {
      const sessionId = requireString(args, 'session_id')
      return { sessionId, ...(await client.cancel(sessionId, { signal })) }
    }
    default:
      throw new DshRpcError(`Unknown tool: ${String(name)}`, { code: 'unknown-tool' })
  }
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
}

function toolError(error) {
  const value = {
    error: error instanceof DshRpcError ? error.code : 'internal-error',
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof DshRpcError && error.method !== undefined ? { method: error.method } : {}),
    ...(error instanceof DshRpcError && error.details !== undefined ? { details: error.details } : {}),
  }
  return { ...toolResult(value), isError: true }
}

async function handleRequest(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    const requested = params?.protocolVersion
    const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : '2025-06-18'
    return { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO }
  }
  if (method === 'ping') return {}
  if (method === 'tools/list') return { tools }
  if (method === 'tools/call') {
    const controller = new AbortController()
    controllers.set(String(id), controller)
    try {
      return toolResult(await callTool(params?.name, params?.arguments ?? {}, controller.signal))
    } catch (error) {
      return toolError(error)
    } finally {
      controllers.delete(String(id))
    }
  }
  const error = new Error(`Method not found: ${String(method)}`)
  error.code = -32601
  throw error
}

async function handleMessage(message) {
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message?.id !== undefined) write({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Invalid Request' } })
    return
  }
  if (message.method === 'notifications/cancelled') {
    controllers.get(String(message.params?.requestId))?.abort(new Error(message.params?.reason ?? 'cancelled'))
    return
  }
  if (message.id === undefined) return
  try {
    write({ jsonrpc: '2.0', id: message.id, result: await handleRequest(message) })
  } catch (error) {
    write({
      jsonrpc: '2.0', id: message.id,
      error: { code: Number.isInteger(error?.code) ? error.code : -32603, message: error instanceof Error ? error.message : String(error) },
    })
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  if (line.trim() === '') return
  let message
  try { message = JSON.parse(line) } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  void handleMessage(message)
})

process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(0))
