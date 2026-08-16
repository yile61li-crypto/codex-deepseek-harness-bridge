#!/usr/bin/env node

import { createInterface } from 'node:readline'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { DshClient, DshRpcError, parsePermissionPreset } from '../src/dsh-client.mjs'
import { DshRuntimeError, DshRuntimeManager } from '../src/dsh-runtime.mjs'
import { PermissionSettings, PermissionSettingsError } from '../src/permission-settings.mjs'

const SERVER_INFO = { name: 'deepseek-harness-bridge', version: '0.6.1' }
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])
const PERMISSION_RANK = Object.freeze({ 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 })
const MCP_IMAGE_RESULT = Symbol('mcp-image-result')
const controllers = new Map()
const client = new DshClient()
const modelRequestTimes = []
let activeWaits = 0

function booleanEnv(name, fallback = false) {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be true or false`)
}

function integerEnv(name, fallback, minimum, maximum) {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

function optionalEnv(name) {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function stringArrayJsonEnv(name) {
  const value = process.env[name]
  if (value === undefined || value === '') return []
  let parsed
  try { parsed = JSON.parse(value) } catch {
    throw new Error(`${name} must be a JSON array of absolute directory paths`)
  }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${name} must be a JSON array of absolute directory paths`)
  }
  return [...new Set(parsed.map(item => item.trim()))]
}

function isNetworkOrDevicePath(value) {
  return value.startsWith('\\\\') || value.startsWith('//')
}

async function canonicalConfiguredRoots(values) {
  const roots = []
  for (const value of values) {
    if (isNetworkOrDevicePath(value) || !isAbsolute(value)) {
      throw new Error('DSH_ALLOWED_WORKSPACE_ROOTS_JSON entries must be absolute local paths')
    }
    const normalized = resolve(value)
    if (normalized === parse(normalized).root) {
      throw new Error('DSH_ALLOWED_WORKSPACE_ROOTS_JSON must not contain a filesystem root')
    }
    let canonical
    let metadata
    try {
      canonical = await realpath(normalized)
      metadata = await stat(canonical)
    } catch {
      throw new Error('DSH_ALLOWED_WORKSPACE_ROOTS_JSON entries must be existing directories')
    }
    if (!metadata.isDirectory()) throw new Error('DSH_ALLOWED_WORKSPACE_ROOTS_JSON entries must be directories')
    roots.push(canonical)
  }
  return [...new Set(roots)]
}

const APPROVAL_RESPONSES_ENABLED = booleanEnv('DSH_ENABLE_APPROVAL_RESPONSES')
const QUESTION_RESPONSES_ENABLED = booleanEnv('DSH_ENABLE_QUESTION_RESPONSES')
const INSTALLATION_DEFAULT_PERMISSION = parsePermissionPreset(process.env.DSH_DEFAULT_PERMISSION ?? 'read-only')
const MAX_PERMISSION = parsePermissionPreset(process.env.DSH_MAX_PERMISSION ?? 'danger-full-access')
const DEFAULT_CWD = optionalEnv('DSH_DEFAULT_CWD')
const DEFAULT_WORKSPACE_ID = optionalEnv('DSH_DEFAULT_WORKSPACE_ID')
const MAX_CONCURRENT_WAITS = integerEnv('DSH_MAX_CONCURRENT_WAITS', 4, 1, 32)
const MODEL_REQUESTS_PER_MINUTE = integerEnv('DSH_MODEL_REQUESTS_PER_MINUTE', 12, 1, 120)
const RUNTIME_START_TIMEOUT_MS = integerEnv('DSH_RUNTIME_START_TIMEOUT_MS', 30_000, 1_000, 120_000)
const MAX_ATTACHMENT_BYTES = integerEnv('DSH_MAX_ATTACHMENT_BYTES', 5 * 1024 * 1024, 1, 25 * 1024 * 1024)
const MAX_PROMPT_CHARS = integerEnv('DSH_MAX_PROMPT_CHARS', 50_000, 1_000, 1_000_000)
const WORKSPACE_CREATION_ENABLED = booleanEnv('DSH_ENABLE_WORKSPACE_CREATION')
const CONFIGURED_WORKSPACE_ROOTS = stringArrayJsonEnv('DSH_ALLOWED_WORKSPACE_ROOTS_JSON')
if (PERMISSION_RANK[INSTALLATION_DEFAULT_PERMISSION] > PERMISSION_RANK[MAX_PERMISSION]) {
  throw new Error('DSH_DEFAULT_PERMISSION must not exceed DSH_MAX_PERMISSION')
}
if (DEFAULT_CWD !== undefined && DEFAULT_WORKSPACE_ID !== undefined) {
  throw new Error('DSH_DEFAULT_CWD and DSH_DEFAULT_WORKSPACE_ID are mutually exclusive')
}
if (WORKSPACE_CREATION_ENABLED && CONFIGURED_WORKSPACE_ROOTS.length === 0) {
  throw new Error('DSH_ENABLE_WORKSPACE_CREATION=true requires DSH_ALLOWED_WORKSPACE_ROOTS_JSON')
}
const ALLOWED_WORKSPACE_ROOTS = WORKSPACE_CREATION_ENABLED
  ? await canonicalConfiguredRoots(CONFIGURED_WORKSPACE_ROOTS)
  : []
const runtime = new DshRuntimeManager({
  baseUrl: client.baseUrl.origin,
  env: process.env,
  startupTimeoutMs: RUNTIME_START_TIMEOUT_MS,
})
const permissionSettings = new PermissionSettings({
  env: process.env,
  maxPermission: MAX_PERMISSION,
  installationDefault: INSTALLATION_DEFAULT_PERMISSION,
})

function bridgePolicy() {
  return {
    defaultPermission: permissionSettings.defaultPermission,
    maxPermission: MAX_PERMISSION,
    defaultTarget: DEFAULT_WORKSPACE_ID === undefined
      ? DEFAULT_CWD === undefined ? null : { cwd: DEFAULT_CWD }
      : { workspaceId: DEFAULT_WORKSPACE_ID },
    approvalResponsesEnabled: APPROVAL_RESPONSES_ENABLED,
    questionResponsesEnabled: QUESTION_RESPONSES_ENABLED,
    maxConcurrentWaits: MAX_CONCURRENT_WAITS,
    modelRequestsPerMinute: MODEL_REQUESTS_PER_MINUTE,
    runtimeStartTimeoutMs: RUNTIME_START_TIMEOUT_MS,
    maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
    maxPromptChars: MAX_PROMPT_CHARS,
    workspaceCreationEnabled: WORKSPACE_CREATION_ENABLED,
    allowedWorkspaceRootCount: ALLOWED_WORKSPACE_ROOTS.length,
    conversationRouting: 'reuse-related-exact-session',
    implicitGlobalLastSession: false,
    permissionCeilingEnforcement: 'bridge-request-boundary-non-atomic',
  }
}

const tools = [
  {
    name: 'dsh_runtime_status',
    description: 'Check whether the configured loopback DSH Web runtime is reachable. This never starts, stops, or restarts a process.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_ensure_runtime',
    description: 'Idempotently reuse a healthy loopback DSH Web runtime or start the configured local DSH CLI. Returns the exact URL for Codex built-in Browser handoff.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_health',
    description: 'Check the loopback DSH runtime and report the bridge safety policy. host.version is only DSH\'s reported API placeholder, not a reliable product version.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_set_default_permission',
    description: 'Persist the default permission for future DSH tasks. Call only after the user explicitly requests this setting change; existing sessions are never modified.',
    inputSchema: {
      type: 'object',
      properties: {
        permission: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
        user_confirmed: { type: 'boolean', enum: [true], description: 'Must be true only when the user explicitly requested this default change.' },
      },
      required: ['permission', 'user_confirmed'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_list_workspaces',
    description: 'List DSH workspaces and their session ids so a new task can be placed deliberately instead of becoming ungrouped.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_create_workspace',
    description: 'Register an existing local directory as a new DSH workspace/group. Requires the operator-enabled creation gate, an allowed canonical root, and explicit user confirmation; never use it as an automatic fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'Existing absolute directory to register. This tool does not create, move, or delete filesystem content.' },
        user_confirmed: { type: 'boolean', enum: [true], description: 'Must be true only when the user explicitly requested this workspace/group in the current conversation.' },
      },
      required: ['path', 'user_confirmed'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'dsh_list_agent_presets',
    description: 'List the agent presets available in this DSH installation. A broken preset is reported but never selected automatically.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_list_sessions',
    description: 'List recent sessions visible in DSH Web, optionally filtered to one workspace or running sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', minLength: 1 },
        running_only: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_get_session',
    description: 'Read one exact DSH session, its workspace grouping, and optionally a bounded recent message history.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1, maxLength: 512 },
        include_history: { type: 'boolean', default: false },
        max_messages: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_search_sessions',
    description: 'Search DSH session text to find the exact conversation to continue. Results are bounded by DSH.',
    inputSchema: {
      type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 500 } },
      required: ['query'], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_get_models',
    description: 'Read the advisory DSH model catalog for one session. routable=true is required before starting a model turn.',
    inputSchema: {
      type: 'object', properties: { session_id: { type: 'string', minLength: 1 } },
      required: ['session_id'], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_start_task',
    description: 'Create a new visible DSH session only for an explicit new conversation, a materially unrelated objective, a different workspace/trust boundary, or isolated parallel work. Use dsh_send for related follow-ups.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', minLength: 1, maxLength: MAX_PROMPT_CHARS, description: 'Task sent to DeepSeek Harness.' },
        cwd: { type: 'string', minLength: 1, description: 'Absolute workspace path used by DSH.' },
        workspace_id: { type: 'string', minLength: 1, description: 'Existing DSH workspace id; mutually exclusive with cwd.' },
        agent_preset: { type: 'string', minLength: 1, description: 'Optional explicit preset. Omit to use the DSH deployment default.' },
        permission: {
          type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'],
          description: 'Session permission set before submission. It must not exceed DSH_MAX_PERMISSION; write modes require a registered workspace_id.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'dsh_rename_session',
    description: 'Rename one DSH session. This changes only session metadata, not its messages or files.',
    inputSchema: {
      type: 'object', properties: {
        session_id: { type: 'string', minLength: 1 }, title: { type: 'string', minLength: 1, maxLength: 200 },
      }, required: ['session_id', 'title'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_fork_session',
    description: 'Fork a DSH session at a completed turn boundary without invoking a model. Returns a new session_id.',
    inputSchema: {
      type: 'object', properties: {
        session_id: { type: 'string', minLength: 1 }, at_seq: { type: 'integer', minimum: 0 },
      }, required: ['session_id'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'dsh_set_permission',
    description: 'Change one existing DSH session permission through the host /permission command, never above the operator-configured maximum.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1 },
        permission: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
      },
      required: ['session_id', 'permission'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'dsh_send',
    description: 'Continue one exact visible DSH session; this is the default for related planning, implementation, testing, fixes, documentation, and follow-ups. Queue starts a later turn; steer refines a currently running turn.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1 },
        message: { type: 'string', minLength: 1, maxLength: MAX_PROMPT_CHARS },
        mode: { type: 'string', enum: ['queue', 'steer'], default: 'queue' },
      },
      required: ['session_id', 'message'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'dsh_wait',
    description: 'Wait for DSH progress or completion. Exact approvals/questions are surfaced for explicit handling; this tool never responds automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1 },
        after_seq: { type: 'integer', minimum: -1, default: -1 },
        prompt_rpc_id: { type: 'string', minLength: 1, description: 'promptRpcId returned by dsh_start_task/dsh_send; keeps queued follow-ups bound to the intended turn.' },
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
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'dsh_answer_question',
    description: 'Answer or cancel one exact pending DSH question batch. Disabled by default and never called without the user supplying the answers.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1 },
        rpc_id: { type: 'string', minLength: 1 },
        action: { type: 'string', enum: ['answer', 'cancel'], default: 'answer' },
        answers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              selected: { type: 'array', items: { type: 'string' }, uniqueItems: true },
              custom: { type: 'string', minLength: 1 },
            },
            required: ['id', 'selected'], additionalProperties: false,
          },
        },
        cancel_message: { type: 'string', minLength: 1 },
      },
      required: ['session_id', 'rpc_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'dsh_history',
    description: 'Read bounded message history with a correct backward cursor and optional truncated tool activity. Raw token chunks are never returned.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1 },
        before_seq: { type: 'integer', minimum: 0 },
        max_messages: { type: 'integer', minimum: 1, maximum: 50, default: 8 },
        max_chars: { type: 'integer', minimum: 1000, maximum: 100000, default: 30000 },
        include_tools: { type: 'boolean', default: false },
        max_tool_events: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dsh_get_attachment',
    description: 'Read one session-authorized DSH image as MCP ImageContent. This raw-image tool is intended for a fork_turns=none Codex vision subagent; the main conversation should use only history attachment metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1 },
        attachment_id: { type: 'string', minLength: 1, maxLength: 512 },
      },
      required: ['session_id', 'attachment_id'],
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
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
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

function optionalBoolean(args, key, fallback = false) {
  const value = args?.[key] ?? fallback
  if (typeof value !== 'boolean') throw new DshRpcError(`${key} must be a boolean`, { code: 'invalid-argument' })
  return value
}

function permissionFrom(args, key, fallback) {
  return parsePermissionPreset(args?.[key] ?? fallback)
}

function ensurePermissionAllowed(permission) {
  if (PERMISSION_RANK[permission] > PERMISSION_RANK[MAX_PERMISSION]) {
    throw new DshRpcError(`${permission} exceeds the bridge operator's maximum permission`, {
      code: 'permission-exceeds-maximum', details: { requested: permission, maximum: MAX_PERMISSION },
    })
  }
  return permission
}

function validateSchemaValue(value, schema, path) {
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    throw new DshRpcError(`${path} must be one of: ${schema.enum.join(', ')}`, { code: 'invalid-argument' })
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new DshRpcError(`${path} must be a string`, { code: 'invalid-argument' })
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new DshRpcError(`${path} is too short`, { code: 'invalid-argument' })
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new DshRpcError(`${path} is too long`, { code: 'invalid-argument' })
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) throw new DshRpcError(`${path} must be an integer`, { code: 'invalid-argument' })
    if (schema.minimum !== undefined && value < schema.minimum) throw new DshRpcError(`${path} is below its minimum`, { code: 'invalid-argument' })
    if (schema.maximum !== undefined && value > schema.maximum) throw new DshRpcError(`${path} exceeds its maximum`, { code: 'invalid-argument' })
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new DshRpcError(`${path} must be a boolean`, { code: 'invalid-argument' })
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new DshRpcError(`${path} must be an array`, { code: 'invalid-argument' })
    if (schema.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) {
      throw new DshRpcError(`${path} must not contain duplicates`, { code: 'invalid-argument' })
    }
    value.forEach((item, index) => validateSchemaValue(item, schema.items ?? {}, `${path}[${index}]`))
  } else if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new DshRpcError(`${path} must be an object`, { code: 'invalid-argument' })
    }
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) throw new DshRpcError(`${path}.${key} is required`, { code: 'invalid-argument' })
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (schema.properties?.[key] === undefined) throw new DshRpcError(`Unknown argument: ${path}.${key}`, { code: 'invalid-argument' })
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined) validateSchemaValue(value[key], propertySchema, `${path}.${key}`)
    }
  }
}

function validateToolArguments(name, args) {
  const definition = tools.find(tool => tool.name === name)
  if (definition === undefined) throw new DshRpcError(`Unknown tool: ${String(name)}`, { code: 'unknown-tool' })
  validateSchemaValue(args, definition.inputSchema, 'arguments')
}

function validatedCwd(value) {
  if (!isAbsolute(value)) throw new DshRpcError('cwd must be an absolute path', { code: 'invalid-workspace-target' })
  const normalized = resolve(value)
  if (normalized === parse(normalized).root) {
    throw new DshRpcError('cwd must not be a filesystem root', { code: 'invalid-workspace-target' })
  }
  return normalized
}

function isWithinRoot(candidate, root) {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  )
}

async function validatedWorkspaceCreationPath(value) {
  if (!WORKSPACE_CREATION_ENABLED) {
    throw new DshRpcError('Workspace creation is disabled by the bridge operator', {
      code: 'workspace-creation-disabled',
      details: { requiredEnvironment: 'DSH_ENABLE_WORKSPACE_CREATION=true' },
    })
  }
  if (isNetworkOrDevicePath(value)) {
    throw new DshRpcError('Workspace creation requires a local directory path', { code: 'invalid-workspace-target' })
  }
  const normalized = validatedCwd(value)
  let canonical
  let metadata
  try {
    canonical = await realpath(normalized)
    metadata = await stat(canonical)
  } catch {
    throw new DshRpcError('Workspace creation requires an existing directory', { code: 'invalid-workspace-target' })
  }
  if (!metadata.isDirectory()) {
    throw new DshRpcError('Workspace creation requires a directory', { code: 'invalid-workspace-target' })
  }
  if (!ALLOWED_WORKSPACE_ROOTS.some(root => isWithinRoot(canonical, root))) {
    throw new DshRpcError('Workspace path is outside the operator-configured roots', {
      code: 'workspace-target-not-allowed',
    })
  }
  return canonical
}

function resolveTaskTarget(args, permission) {
  const explicitCwd = optionalString(args, 'cwd')
  const explicitWorkspaceId = optionalString(args, 'workspace_id')
  if (explicitCwd !== undefined && explicitWorkspaceId !== undefined) {
    throw new DshRpcError('cwd and workspace_id are mutually exclusive', { code: 'invalid-argument' })
  }
  const cwd = explicitCwd ?? (explicitWorkspaceId === undefined ? DEFAULT_CWD : undefined)
  const workspaceId = explicitWorkspaceId ?? (explicitCwd === undefined ? DEFAULT_WORKSPACE_ID : undefined)
  if (cwd === undefined && workspaceId === undefined) {
    throw new DshRpcError('Choose an existing session to continue, or specify workspace_id/cwd for a new session', {
      code: 'task-target-required', details: { nextTools: ['dsh_list_workspaces', 'dsh_list_sessions'] },
    })
  }
  if (permission !== 'read-only' && workspaceId === undefined) {
    throw new DshRpcError('Writable permissions require an operator-registered DSH workspace_id', {
      code: 'registered-workspace-required', details: { permission },
    })
  }
  return workspaceId === undefined ? { cwd: validatedCwd(cwd) } : { workspaceId }
}

function consumeModelRequestQuota() {
  const cutoff = Date.now() - 60_000
  while (modelRequestTimes[0] !== undefined && modelRequestTimes[0] <= cutoff) modelRequestTimes.shift()
  if (modelRequestTimes.length >= MODEL_REQUESTS_PER_MINUTE) {
    throw new DshRpcError('Model request rate limit reached; retry after the one-minute window', {
      code: 'model-rate-limited', details: { limit: MODEL_REQUESTS_PER_MINUTE, windowSeconds: 60 },
    })
  }
  modelRequestTimes.push(Date.now())
}

function workspaceMap(workspaceResult) {
  const map = new Map()
  for (const workspace of workspaceResult.workspaces) {
    for (const sessionId of workspace.sessionIds) {
      map.set(sessionId, { workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, workspacePath: workspace.path })
    }
  }
  return map
}

function ensureSessionWithinPolicy(session, workspaces) {
  const permission = session.permissions
  if (PERMISSION_RANK[permission] === undefined) {
    throw new DshRpcError('The session permission is unknown; set an explicit permitted value before continuing', {
      code: 'session-permission-unknown', details: { sessionId: session.sessionId, permission },
    })
  }
  if (PERMISSION_RANK[permission] > PERMISSION_RANK[MAX_PERMISSION]) {
    throw new DshRpcError('The existing session exceeds this bridge instance\'s permission ceiling; downgrade it before continuing', {
      code: 'session-permission-exceeds-maximum',
      details: { sessionId: session.sessionId, current: permission, maximum: MAX_PERMISSION },
    })
  }
  if (permission !== 'read-only' && !workspaceMap(workspaces).has(session.sessionId)) {
    throw new DshRpcError('Writable sessions must belong to an operator-registered DSH workspace before continuing', {
      code: 'registered-workspace-required', details: { sessionId: session.sessionId, permission },
    })
  }
}

function requestKey(id) {
  return `${typeof id}:${String(id)}`
}

async function callTool(name, args, signal) {
  validateToolArguments(name, args)
  switch (name) {
    case 'dsh_runtime_status':
      return runtime.status({ signal })
    case 'dsh_ensure_runtime':
      return runtime.ensure({ signal })
    case 'dsh_health': {
      await permissionSettings.refresh()
      const health = await client.health({ signal })
      const optional = await Promise.allSettled([client.listWorkspaces({ signal }), client.listAgentPresets({ signal })])
      return {
        ...health,
        reportedHostApiVersion: health.host?.version ?? null,
        testedDshVersions: ['0.1.0-rc.6'],
        optionalCapabilities: {
          workspaces: optional[0].status === 'fulfilled', agentPresets: optional[1].status === 'fulfilled',
        },
        bridgePolicy: bridgePolicy(),
      }
    }
    case 'dsh_set_default_permission': {
      const permission = ensurePermissionAllowed(permissionFrom(args, 'permission'))
      return {
        ...(await permissionSettings.setDefault(permission)),
        maxPermission: MAX_PERMISSION,
        appliesTo: 'future-tasks-only',
      }
    }
    case 'dsh_list_workspaces':
      return client.listWorkspaces({ signal })
    case 'dsh_create_workspace':
      return client.createWorkspace(await validatedWorkspaceCreationPath(requireString(args, 'path')), { signal })
    case 'dsh_list_agent_presets':
      return client.listAgentPresets({ signal })
    case 'dsh_list_sessions': {
      const [sessions, workspaces] = await Promise.all([client.listSessions({ signal }), client.listWorkspaces({ signal })])
      const groups = workspaceMap(workspaces)
      const workspaceId = optionalString(args, 'workspace_id')
      const runningOnly = optionalBoolean(args, 'running_only')
      const limit = optionalInteger(args, 'limit', 20, 1, 100)
      const visible = sessions
        .map(session => ({
          ...session, archived: false,
          ...(groups.get(session.sessionId) ?? { workspaceId: null, workspaceTitle: null, workspacePath: null }),
        }))
        .filter(session => workspaceId === undefined || session.workspaceId === workspaceId)
        .filter(session => !runningOnly || session.running)
        .slice(0, limit)
      return {
        sessions: visible, returned: visible.length, totalVisible: sessions.length,
        archivedSessionIds: workspaces.archivedSessionIds,
      }
    }
    case 'dsh_get_session': {
      const sessionId = requireString(args, 'session_id')
      const [session, workspaces] = await Promise.all([client.getSession(sessionId, { signal }), client.listWorkspaces({ signal })])
      const grouped = {
        ...session, archived: false,
        ...(workspaceMap(workspaces).get(sessionId) ?? { workspaceId: null, workspaceTitle: null, workspacePath: null }),
      }
      if (!optionalBoolean(args, 'include_history')) return { session: grouped }
      return {
        session: grouped,
        history: await client.history(sessionId, {
          maxMessages: optionalInteger(args, 'max_messages', 8, 1, 20), signal,
        }),
      }
    }
    case 'dsh_search_sessions':
      return client.searchSessions(requireString(args, 'query'), { signal })
    case 'dsh_get_models':
      return client.getModels(requireString(args, 'session_id'), { signal })
    case 'dsh_start_task': {
      const task = requireString(args, 'task')
      if (args?.permission === undefined) await permissionSettings.refresh()
      const permission = ensurePermissionAllowed(permissionFrom(args, 'permission', permissionSettings.defaultPermission))
      const target = resolveTaskTarget(args, permission)
      consumeModelRequestQuota()
      const created = await client.createSession({
        ...target,
        agentPreset: optionalString(args, 'agent_preset'),
      }, { signal })
      try {
        await client.setPermission(created.sessionId, permission, { signal })
        const baseline = await client.getSession(created.sessionId, { signal })
        if (baseline.permissions !== permission) {
          throw new DshRpcError('DSH did not apply the requested permission before prompt submission', {
            code: 'permission-not-applied',
            details: { requested: permission, observed: baseline.permissions },
          })
        }
        const accepted = await client.prompt(created.sessionId, task, { mode: 'queue', signal })
        return {
          ...created, ...target, permission, accepted: accepted.accepted === true,
          promptRpcId: accepted.promptRpcId, visibleInWebUi: true,
          waitAfterSeq: baseline.lastSeq ?? -1,
          continueWith: { tool: 'dsh_send', sessionId: created.sessionId },
        }
      } catch (error) {
        if (error instanceof DshRpcError) error.details = { ...error.details, createdSessionId: created.sessionId }
        throw error
      }
    }
    case 'dsh_rename_session': {
      const sessionId = requireString(args, 'session_id')
      return { sessionId, ...(await client.renameSession(sessionId, requireString(args, 'title'), { signal })) }
    }
    case 'dsh_fork_session': {
      const sourceSessionId = requireString(args, 'session_id')
      const result = await client.forkSession(sourceSessionId, {
        atSeq: args?.at_seq === undefined ? undefined : optionalInteger(args, 'at_seq', 0, 0, Number.MAX_SAFE_INTEGER), signal,
      })
      return { sourceSessionId, sessionId: result.sessionId, continueWith: { tool: 'dsh_send', sessionId: result.sessionId } }
    }
    case 'dsh_set_permission': {
      const sessionId = requireString(args, 'session_id')
      const permission = ensurePermissionAllowed(permissionFrom(args, 'permission'))
      if (permission !== 'read-only') {
        const workspaces = await client.listWorkspaces({ signal })
        if (!workspaceMap(workspaces).has(sessionId)) {
          throw new DshRpcError('Writable permissions require a session in an operator-registered DSH workspace', {
            code: 'registered-workspace-required', details: { sessionId, permission },
          })
        }
      }
      return client.setPermission(sessionId, permission, { signal })
    }
    case 'dsh_send': {
      const sessionId = requireString(args, 'session_id')
      const message = requireString(args, 'message')
      const mode = args?.mode ?? 'queue'
      if (mode !== 'queue' && mode !== 'steer') throw new DshRpcError('mode must be queue or steer', { code: 'invalid-argument' })
      const [baseline, workspaces] = await Promise.all([
        client.getSession(sessionId, { signal }), client.listWorkspaces({ signal }),
      ])
      ensureSessionWithinPolicy(baseline, workspaces)
      const verified = await client.getSession(sessionId, { signal })
      ensureSessionWithinPolicy(verified, workspaces)
      if (verified.permissions !== baseline.permissions) {
        throw new DshRpcError('Session permission changed while preparing the prompt; retry after it stabilizes', {
          code: 'session-permission-changed',
          details: { before: baseline.permissions, observed: verified.permissions },
        })
      }
      consumeModelRequestQuota()
      return {
        sessionId, ...(await client.prompt(sessionId, message, { mode, signal })),
        waitAfterSeq: verified.lastSeq ?? -1, continueWith: { tool: 'dsh_send', sessionId },
      }
    }
    case 'dsh_wait': {
      if (activeWaits >= MAX_CONCURRENT_WAITS) {
        throw new DshRpcError('Too many concurrent dsh_wait calls', {
          code: 'wait-concurrency-limit', details: { maximum: MAX_CONCURRENT_WAITS },
        })
      }
      activeWaits += 1
      let result
      try {
        result = await client.wait(requireString(args, 'session_id'), {
          afterSeq: optionalInteger(args, 'after_seq', -1, -1, Number.MAX_SAFE_INTEGER),
          promptRpcId: optionalString(args, 'prompt_rpc_id'),
          timeoutMs: optionalInteger(args, 'timeout_ms', 30_000, 100, 300_000),
          signal,
        })
      } finally {
        activeWaits -= 1
      }
      if (result.kind === 'approval' && result.approval !== undefined) {
        result.approval.responseEnabled = APPROVAL_RESPONSES_ENABLED
        result.approval.responseMode = APPROVAL_RESPONSES_ENABLED ? 'mcp-or-web-ui' : 'web-ui-only'
      }
      if (result.kind === 'question' && result.question !== undefined) {
        result.question.responseEnabled = QUESTION_RESPONSES_ENABLED
        result.question.responseMode = QUESTION_RESPONSES_ENABLED ? 'mcp-or-web-ui' : 'web-ui-only'
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
    case 'dsh_answer_question': {
      if (!QUESTION_RESPONSES_ENABLED) {
        throw new DshRpcError('MCP question responses are disabled; answer in DSH Web instead', {
          code: 'question-responses-disabled',
          details: { requiredEnvironment: 'DSH_ENABLE_QUESTION_RESPONSES=true' },
        })
      }
      const action = args?.action ?? 'answer'
      const rpcId = requireString(args, 'rpc_id')
      if (action === 'cancel') {
        if (args?.answers !== undefined) throw new DshRpcError('answers must be omitted when cancelling', { code: 'invalid-argument' })
        return client.cancelQuestion({ rpcId, message: optionalString(args, 'cancel_message') ?? 'Cancelled by user' }, { signal })
      }
      if (args?.cancel_message !== undefined) throw new DshRpcError('cancel_message is only valid for action=cancel', { code: 'invalid-argument' })
      return client.respondQuestion({
        sessionId: requireString(args, 'session_id'), rpcId, answers: args?.answers,
      }, { signal })
    }
    case 'dsh_history':
      return client.history(requireString(args, 'session_id'), {
        beforeSeq: args?.before_seq === undefined ? undefined : optionalInteger(args, 'before_seq', 0, 0, Number.MAX_SAFE_INTEGER),
        maxMessages: optionalInteger(args, 'max_messages', 8, 1, 50),
        maxChars: optionalInteger(args, 'max_chars', 30_000, 1_000, 100_000),
        includeTools: optionalBoolean(args, 'include_tools'),
        maxToolEvents: optionalInteger(args, 'max_tool_events', 20, 1, 100),
        signal,
      })
    case 'dsh_get_attachment': {
      const image = await client.getAttachment(
        requireString(args, 'session_id'), requireString(args, 'attachment_id'),
        { signal, maxBytes: MAX_ATTACHMENT_BYTES },
      )
      return {
        [MCP_IMAGE_RESULT]: true,
        metadata: {
          attachment: image.attachment,
          isolation: 'codex-vision-subagent-only',
        },
        data: image.data,
      }
    }
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
  if (value?.[MCP_IMAGE_RESULT] === true) {
    return {
      content: [
        { type: 'text', text: JSON.stringify(value.metadata, null, 2) },
        { type: 'image', data: value.data, mimeType: value.metadata.attachment.mediaType },
      ],
      structuredContent: value.metadata,
    }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
}

function toolError(error) {
  const structured = error instanceof DshRpcError || error instanceof DshRuntimeError || error instanceof PermissionSettingsError
  const value = {
    error: structured ? error.code : 'internal-error',
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof DshRpcError && error.method !== undefined ? { method: error.method } : {}),
    ...(structured && error.details !== undefined ? { details: error.details } : {}),
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
    const key = requestKey(id)
    controllers.set(key, controller)
    try {
      return toolResult(await callTool(params?.name, params?.arguments ?? {}, controller.signal))
    } catch (error) {
      return toolError(error)
    } finally {
      controllers.delete(key)
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
    controllers.get(requestKey(message.params?.requestId))?.abort(new Error(message.params?.reason ?? 'cancelled'))
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
