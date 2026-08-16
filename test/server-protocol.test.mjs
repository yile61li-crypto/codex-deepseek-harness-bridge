import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { it } from 'node:test'

it('implements MCP initialize and tools/list over stdio', async () => {
  const child = spawn(process.execPath, ['scripts/server.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] })
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

  const deadline = Date.now() + 5_000
  while (replies.length < 4 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  child.kill()
  await once(child, 'exit')

  const byId = Object.fromEntries(replies.map(reply => [reply.id, reply]))
  assert.equal(byId[1].result.protocolVersion, '2025-06-18')
  assert.equal(byId[2].result.tools.length, 9)
  assert.deepEqual(byId[2].result.tools.map(tool => tool.name), [
    'dsh_health', 'dsh_list_sessions', 'dsh_start_task', 'dsh_set_permission', 'dsh_send', 'dsh_wait',
    'dsh_answer_approval', 'dsh_history', 'dsh_cancel',
  ])
  assert.equal(byId[3].result.isError, true)
  assert.equal(byId[3].result.structuredContent.error, 'approval-responses-disabled')
  assert.equal(byId[4].result.isError, true)
  assert.equal(byId[4].result.structuredContent.error, 'danger-full-access-disabled')
})
