import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { DshClient, DshRpcError, normalizeBaseUrl, summarizeHistoryValue } from '../src/dsh-client.mjs'

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
      if (message.method === 'session.list') {
        response.end(JSON.stringify({
          type: 'server-response', rpcId: message.rpcId,
          result: { ok: true, value: { items: [{
            sessionId: 's1', updatedAt: 1, running: false, blank: false, cwd: '/work', agentPreset: 'standard',
            projections: { asOfSeq: 9, values: { title: 'Visible session', permissions: { currentValue: 'workspace-write' } } },
          }] } },
        }))
      } else {
        response.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { accepted: true } } }))
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
})
