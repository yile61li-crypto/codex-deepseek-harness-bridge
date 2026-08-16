#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'

const root = path.resolve(import.meta.dirname, '..')
const npmCli = process.env.npm_execpath
if (typeof npmCli !== 'string' || npmCli === '') {
  throw new Error('package smoke must be started through npm so npm_execpath is available')
}

function npm(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error([
      `npm ${args.join(' ')} failed with status ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  return result.stdout
}

async function probeServer(serverPath, cwd, settingsFile) {
  const child = spawn(process.execPath, [serverPath], {
    cwd,
    env: {
      ...process.env,
      DSH_SETTINGS_FILE: settingsFile,
      DSH_ENABLE_WORKSPACE_CREATION: 'false',
      DSH_ALLOWED_WORKSPACE_ROOTS_JSON: '[]',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let nextId = 1
  let stderr = ''

  child.stderr.on('data', chunk => { stderr += String(chunk) })
  createInterface({ input: child.stdout }).on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    const request = pending.get(message.id)
    if (request === undefined) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error !== undefined) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })

  function request(method, params = {}) {
    const id = nextId
    nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`packed MCP request timed out: ${method}`))
      }, 10_000)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  try {
    const initialized = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'package-smoke', version: '1' },
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const listed = await request('tools/list')
    if (initialized.serverInfo?.version !== '0.6.1') {
      throw new Error(`packed server reported unexpected version: ${initialized.serverInfo?.version}`)
    }
    if (!Array.isArray(listed.tools) || listed.tools.length === 0) {
      throw new Error('packed server returned no MCP tools')
    }
    return { version: initialized.serverInfo.version, toolCount: listed.tools.length }
  } finally {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('packed MCP server stopped'))
    }
    pending.clear()
    child.stdin.end()
    if (child.exitCode === null) child.kill()
    if (child.exitCode === null) await once(child, 'exit')
    if (stderr.trim() !== '') process.stderr.write(stderr)
  }
}

const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-bridge-package-smoke-'))
try {
  const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', scratch], root))
  const archiveName = packed?.[0]?.filename
  if (typeof archiveName !== 'string' || archiveName === '') {
    throw new Error('npm pack did not report an archive filename')
  }

  const consumer = path.join(scratch, 'consumer')
  await mkdir(consumer)
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({
    name: 'deepseek-harness-bridge-package-smoke',
    version: '1.0.0',
    private: true,
  }, null, 2))

  const archive = path.join(scratch, archiveName)
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', archive], consumer)
  const installed = path.join(consumer, 'node_modules', 'codex-deepseek-harness-bridge')
  npm(['run', 'verify'], installed)
  const result = await probeServer(
    path.join(installed, 'scripts', 'server.mjs'),
    consumer,
    path.join(scratch, 'settings.json'),
  )
  process.stdout.write(`Packed artifact smoke passed: v${result.version}, ${result.toolCount} tools\n`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
