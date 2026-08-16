import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { it } from 'node:test'

it('implements MCP initialize and tools/list over stdio', async t => {
  const settingsDirectory = await mkdtemp(join(tmpdir(), 'dsh-bridge-settings-'))
  t.after(() => rm(settingsDirectory, { recursive: true, force: true }))
  const dshRequests = []
  const dsh = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const message = JSON.parse(body)
    dshRequests.push(message)
    let value
    if (message.method === 'session.list') {
      value = { items: [
        { sessionId: 's-high', running: false, blank: false, projections: { asOfSeq: 4, values: { permissions: { currentValue: 'danger-full-access' } } } },
        { sessionId: 's-read', running: false, blank: false, projections: { asOfSeq: 9, values: { permissions: { currentValue: 'read-only' } } } },
      ] }
    } else if (message.method === 'workspace.list') {
      value = { items: [{ workspaceId: 'w1', path: '/work', title: 'Project', sessionIds: ['s-read', 's'] }], archivedSessionIds: [] }
    } else if (message.method === 'workspace.create') {
      value = { created: true, workspace: { workspaceId: 'w2', path: '/new-work', title: 'new-work', sessionIds: [] } }
    } else if (message.method === 'commands/execute') {
      value = { commandId: 'c-permission', result: { kind: 'success', sourceEventSeq: 10 } }
    } else if (message.method === 'session.prompt') {
      value = { accepted: true }
    } else {
      value = {}
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } }))
  })
  await new Promise(resolve => dsh.listen(0, '127.0.0.1', resolve))
  const child = spawn(process.execPath, ['scripts/server.mjs'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSH_WEB_URL: `http://127.0.0.1:${dsh.address().port}`,
      DSH_SETTINGS_FILE: join(settingsDirectory, 'settings.json'),
    },
  })
  const lines = createInterface({ input: child.stdout })
  const replies = []
  lines.on('line', line => replies.push(JSON.parse(line)))

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'dsh_answer_approval', arguments: { session_id: 's', rpc_id: 'r', approval_id: 'a', decision: 'allow_once' },
  } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
    name: 'dsh_set_permission', arguments: { session_id: 's', permission: 'danger-full-access' },
  } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {
    name: 'dsh_answer_question', arguments: { session_id: 's', rpc_id: 'r', action: 'cancel' },
  } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {
    name: 'dsh_health', arguments: { unexpected: true },
  } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {
    name: 'dsh_start_task', arguments: { task: 'must not be submitted' },
  } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: {
    name: 'dsh_start_task', arguments: { task: 'must not be submitted', cwd: '/work', permission: 'workspace-write' },
  } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: {
    name: 'dsh_send', arguments: { session_id: 's-high', message: 'must not run' },
  } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: {
    name: 'dsh_send', arguments: { session_id: 's-read', message: 'continue exactly this session' },
  } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: {
    name: 'dsh_runtime_status', arguments: {},
  } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: {
    name: 'dsh_ensure_runtime', arguments: {},
  } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: {
    name: 'dsh_health', arguments: {},
  } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: {
    name: 'dsh_create_workspace', arguments: { path: '/new-work', user_confirmed: false },
  } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: {
    name: 'dsh_create_workspace', arguments: { path: '/new-work', user_confirmed: true },
  } })}\n`)

  const deadline = Date.now() + 5_000
  while (replies.length < 15 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 16, method: 'tools/call', params: {
    name: 'dsh_set_default_permission', arguments: { permission: 'danger-full-access', user_confirmed: false },
  } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 17, method: 'tools/call', params: {
    name: 'dsh_set_default_permission', arguments: { permission: 'danger-full-access', user_confirmed: true },
  } })}\n`)
  const settingsDeadline = Date.now() + 5_000
  while (replies.length < 17 && Date.now() < settingsDeadline) await new Promise(resolve => setTimeout(resolve, 10))
  child.kill()
  await once(child, 'exit')
  await new Promise(resolve => dsh.close(resolve))

  const byId = Object.fromEntries(replies.map(reply => [reply.id, reply]))
  assert.equal(byId[1].result.protocolVersion, '2025-06-18')
  assert.equal(byId[2].result.tools.length, 21)
  assert.deepEqual(byId[2].result.tools.map(tool => tool.name), [
    'dsh_runtime_status', 'dsh_ensure_runtime', 'dsh_health', 'dsh_set_default_permission',
    'dsh_list_workspaces', 'dsh_create_workspace', 'dsh_list_agent_presets', 'dsh_list_sessions', 'dsh_get_session',
    'dsh_search_sessions', 'dsh_get_models', 'dsh_start_task', 'dsh_rename_session', 'dsh_fork_session',
    'dsh_set_permission', 'dsh_send', 'dsh_wait', 'dsh_answer_approval', 'dsh_answer_question',
    'dsh_history', 'dsh_cancel',
  ])
  const startTool = byId[2].result.tools.find(tool => tool.name === 'dsh_start_task')
  assert.equal(startTool.annotations.destructiveHint, true)
  assert.equal(startTool.annotations.openWorldHint, true)
  assert.equal(byId[3].result.isError, true)
  assert.equal(byId[3].result.structuredContent.error, 'approval-responses-disabled')
  assert.equal(byId[4].result.structuredContent.permission, 'danger-full-access')
  assert.equal(byId[5].result.structuredContent.error, 'question-responses-disabled')
  assert.equal(byId[6].result.structuredContent.error, 'invalid-argument')
  assert.equal(byId[7].result.structuredContent.error, 'task-target-required')
  assert.equal(byId[8].result.structuredContent.error, 'registered-workspace-required')
  assert.equal(byId[9].result.structuredContent.error, 'registered-workspace-required')
  assert.equal(byId[10].result.structuredContent.sessionId, 's-read')
  assert.equal(byId[10].result.structuredContent.waitAfterSeq, 9)
  assert.equal(typeof byId[10].result.structuredContent.promptRpcId, 'string')
  assert.equal(byId[11].result.structuredContent.reachable, true)
  assert.equal(byId[11].result.structuredContent.startMode, 'existing')
  assert.equal(byId[12].result.structuredContent.reachable, true)
  assert.equal(byId[12].result.structuredContent.startMode, 'existing')
  assert.equal(byId[13].result.structuredContent.bridgePolicy.defaultPermission, 'read-only')
  assert.equal(byId[13].result.structuredContent.bridgePolicy.maxPermission, 'danger-full-access')
  assert.equal(byId[14].result.structuredContent.error, 'invalid-argument')
  assert.equal(byId[15].result.structuredContent.created, true)
  assert.equal(byId[15].result.structuredContent.workspace.workspaceId, 'w2')
  assert.equal(byId[16].result.structuredContent.error, 'invalid-argument')
  assert.equal(byId[17].result.structuredContent.previousDefaultPermission, 'read-only')
  assert.equal(byId[17].result.structuredContent.defaultPermission, 'danger-full-access')
  assert.equal(byId[17].result.structuredContent.persisted, true)
  assert.equal(byId[17].result.structuredContent.appliesTo, 'future-tasks-only')
  const permissionCommand = dshRequests.find(request => request.method === 'commands/execute')
  assert.equal(permissionCommand.payload.args.line, '/permission danger-full-access')
  assert.equal(dshRequests.filter(request => request.method === 'workspace.create').length, 1)
  const submitted = dshRequests.find(request => request.method === 'session.prompt')
  assert.equal(submitted.payload.sessionId, 's-read')
  assert.equal(submitted.payload.content[0].text, 'continue exactly this session')
})
