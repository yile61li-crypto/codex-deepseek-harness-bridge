#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const child = spawn(process.execPath, ['scripts/server.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] })
const pending = new Map()
let nextId = 1
let stderr = ''
const requestTimeoutMs = Math.max(10_000, Number(process.env.DSH_RUNTIME_START_TIMEOUT_MS ?? 30_000) + 5_000)

child.stderr.on('data', chunk => { stderr += String(chunk) })
createInterface({ input: child.stdout }).on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  clearTimeout(entry.timer)
  if (message.error !== undefined) entry.reject(new Error(message.error.message))
  else entry.resolve(message.result)
})

function request(method, params = {}) {
  const id = nextId
  nextId += 1
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`MCP request timed out: ${method}`))
    }, requestTimeoutMs)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

async function tool(name, args = {}) {
  const result = await request('tools/call', { name, arguments: args })
  if (result.isError === true) {
    const structured = result.structuredContent
    const details = structured?.details === undefined ? '' : ` ${JSON.stringify(structured.details)}`
    throw new Error(`${name}: ${structured?.message ?? 'tool error'}${details}`)
  }
  return result.structuredContent
}

try {
  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-live-probe', version: '1' },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  const runtime = await tool('dsh_ensure_runtime')
  const [health, workspaces, presets, sessions] = await Promise.all([
    tool('dsh_health'), tool('dsh_list_workspaces'), tool('dsh_list_agent_presets'),
    tool('dsh_list_sessions', { limit: 1 }),
  ])
  process.stdout.write(`${JSON.stringify({
    protocolVersion: initialized.protocolVersion,
    serverVersion: initialized.serverInfo?.version,
    runtimeStartMode: runtime.startMode,
    runtimeBaseUrl: runtime.baseUrl,
    reachable: health.reachable,
    defaultPermission: health.bridgePolicy?.defaultPermission,
    maxPermission: health.bridgePolicy?.maxPermission,
    workspaceCount: workspaces.workspaces?.length ?? 0,
    presetCount: presets.presets?.length ?? 0,
    visibleSessionCount: sessions.totalVisible ?? 0,
  }, null, 2)}\n`)
} finally {
  child.stdin.end()
  child.kill()
  if (stderr.trim() !== '') process.stderr.write(stderr)
}
