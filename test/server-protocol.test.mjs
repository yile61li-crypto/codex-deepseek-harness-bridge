import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { it } from 'node:test'

it('implements MCP initialize and tools/list over stdio', async () => {
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
      value = { items: [{ workspaceId: 'w1', path: '/work', title: 'Project', sessionIds: ['s-read'] }], archivedSessionIds: [] }
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
    env: { ...process.env, DSH_WEB_URL: `http://127.0.0.1:${dsh.address().port}` },
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

  const deadline = Date.now() + 5_000
  while (replies.length < 10 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  child.kill()
  await once(child, 'exit')
  await new Promise(resolve => dsh.close(resolve))

  const byId = Object.fromEntries(replies.map(reply => [reply.id, reply]))
  assert.equal(byId[1].result.protocolVersion, '2025-06-18')
  assert.equal(byId[2].result.tools.length, 17)
  assert.deepEqual(byId[2].result.tools.map(tool => tool.name), [
    'dsh_health', 'dsh_list_workspaces', 'dsh_list_agent_presets', 'dsh_list_sessions', 'dsh_get_session',
    'dsh_search_sessions', 'dsh_get_models', 'dsh_start_task', 'dsh_rename_session', 'dsh_fork_session',
    'dsh_set_permission', 'dsh_send', 'dsh_wait', 'dsh_answer_approval', 'dsh_answer_question',
    'dsh_history', 'dsh_cancel',
  ])
  const startTool = byId[2].result.tools.find(tool => tool.name === 'dsh_start_task')
  assert.equal(startTool.annotations.destructiveHint, true)
  assert.equal(startTool.annotations.openWorldHint, true)
  assert.equal(byId[3].result.isError, true)
  assert.equal(byId[3].result.structuredContent.error, 'approval-responses-disabled')
  assert.equal(byId[4].result.isError, true)
  assert.equal(byId[4].result.structuredContent.error, 'permission-exceeds-maximum')
  assert.equal(byId[5].result.structuredContent.error, 'question-responses-disabled')
  assert.equal(byId[6].result.structuredContent.error, 'invalid-argument')
  assert.equal(byId[7].result.structuredContent.error, 'task-target-required')
  assert.equal(byId[8].result.structuredContent.error, 'registered-workspace-required')
  assert.equal(byId[9].result.structuredContent.error, 'session-permission-exceeds-maximum')
  assert.equal(byId[10].result.structuredContent.sessionId, 's-read')
  assert.equal(byId[10].result.structuredContent.waitAfterSeq, 9)
  assert.equal(typeof byId[10].result.structuredContent.promptRpcId, 'string')
  const submitted = dshRequests.find(request => request.method === 'session.prompt')
  assert.equal(submitted.payload.sessionId, 's-read')
  assert.equal(submitted.payload.content[0].text, 'continue exactly this session')
})
