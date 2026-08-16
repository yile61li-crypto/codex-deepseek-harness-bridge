import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'
import {
  DshClient, DshRpcError, mergeWaitResult, normalizeBaseUrl, summarizeHistoryValue, waitAbortResult,
} from '../src/dsh-client.mjs'

describe('loopback boundary', () => {
  it('accepts loopback and rejects remote or credentialed URLs', () => {
    assert.equal(normalizeBaseUrl('http://127.0.0.1:3080').origin, 'http://127.0.0.1:3080')
    assert.throws(() => normalizeBaseUrl('https://127.0.0.1:3080'), DshRpcError)
    assert.throws(() => normalizeBaseUrl('http://192.168.1.2:3080'), DshRpcError)
    assert.throws(() => normalizeBaseUrl('http://user:pass@127.0.0.1:3080'), DshRpcError)
  })
})

describe('RPC client', () => {
  let server
  let origin
  const requests = []

  before(async () => {
    server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const message = JSON.parse(body)
      requests.push({ path: request.url, message })
      response.setHeader('content-type', 'application/json')
      if (request.url === '/api/respond') {
        response.end(JSON.stringify({ accepted: true }))
        return
      }
      if (message.method === 'session.list') {
        response.end(JSON.stringify({
          type: 'server-response', rpcId: message.rpcId,
          result: { ok: true, value: { items: [{
            sessionId: 's1', updatedAt: 1, running: false, blank: false, cwd: '/work', agentPreset: 'standard',
            projections: { asOfSeq: 9, values: { title: 'Visible session', permissions: { currentValue: 'workspace-write' } } },
          }] } },
        }))
      } else {
        const value = message.method === 'commands/execute'
          ? { commandId: 'cmd-1', result: { kind: 'success', sourceEventSeq: 10 } }
          : { accepted: true }
        response.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } }))
      }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => new Promise(resolve => server.close(resolve)))

  it('uses the DSH envelope and returns compact sessions', async () => {
    const client = new DshClient({ baseUrl: origin })
    const sessions = await client.listSessions()
    assert.deepEqual(sessions, [{
      sessionId: 's1', title: 'Visible session', running: false, blank: false, cwd: '/work',
      agentPreset: 'standard', updatedAt: 1, lastSeq: 9, permissions: 'workspace-write',
    }])
    assert.equal(requests.at(-1).path, '/api/session.list')
    assert.equal(requests.at(-1).message.type, 'client-request')
    assert.equal(requests.at(-1).message.method, 'session.list')
  })

  it('sets one session permission through the host command API', async () => {
    const client = new DshClient({ baseUrl: origin })
    const result = await client.setPermission('s1', 'read-only')
    assert.equal(result.permission, 'read-only')
    assert.equal(requests.at(-1).path, '/api/commands/execute')
    assert.deepEqual(requests.at(-1).message.payload, {
      args: { agentId: 's1', line: '/permission read-only' },
    })
    await assert.rejects(() => client.setPermission('s1', 'unknown'), error => error.code === 'invalid-permission')
  })

  it('answers an exact pending approval through the response carrier', async () => {
    const client = new DshClient({ baseUrl: origin })
    const result = await client.respondApproval({
      sessionId: 's1', rpcId: 'rpc-approval-1', approvalId: 'approval-1', outcome: 'rejected',
    })
    assert.deepEqual(result, { accepted: true, outcome: 'rejected' })
    assert.equal(requests.at(-1).path, '/api/respond')
    assert.deepEqual(requests.at(-1).message, {
      type: 'client-response',
      rpcId: 'rpc-approval-1',
      result: {
        ok: true,
        value: { sessionId: 's1', approvalId: 'approval-1', outcome: 'rejected' },
      },
    })
  })
})

describe('history compaction', () => {
  it('drops chunks and keeps message-level text and finish reason', () => {
    const summary = summarizeHistoryValue({
      hasMore: false,
      events: [
        { event: { type: 'assistant/chunk', seq: 1, data: { chunk: 'x' } } },
        { event: { type: 'user/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'question' }] } } } },
        { event: { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'answer' }] } } } },
        { event: { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } } },
      ],
    })
    assert.equal(summary.lastSeq, 4)
    assert.equal(summary.finalResponse, 'answer')
    assert.equal(summary.finishReason, 'completed')
    assert.deepEqual(summary.messages.map(item => item.text), ['question', 'answer'])
  })

  it('keeps a newer streamed sequence when history has no newer event', () => {
    const merged = mergeWaitResult(
      { state: 'completed', lastSeq: 5 },
      [{ seq: 5, type: 'assistant/chunk' }],
      { lastSeq: -1, messages: [] },
    )
    assert.equal(merged.lastSeq, 5)
  })

  it('distinguishes caller cancellation from an internal wait timeout', () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    assert.deepEqual(waitAbortResult(controller.signal, 7), { state: 'cancelled', lastSeq: 7 })
    assert.deepEqual(waitAbortResult(undefined, 7), { state: 'timeout', lastSeq: 7 })
  })
})
