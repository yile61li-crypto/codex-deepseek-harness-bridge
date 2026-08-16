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

  const deadline = Date.now() + 5_000
  while (replies.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  child.kill()
  await once(child, 'exit')

  assert.equal(replies[0].result.protocolVersion, '2025-06-18')
  assert.equal(replies[1].result.tools.length, 7)
  assert.deepEqual(replies[1].result.tools.map(tool => tool.name), [
    'dsh_health', 'dsh_list_sessions', 'dsh_start_task', 'dsh_send', 'dsh_wait', 'dsh_history', 'dsh_cancel',
  ])
})
