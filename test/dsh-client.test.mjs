import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'
import {
  DshClient, DshRpcError, mergeWaitResult, normalizeBaseUrl, summarizeHistoryValue,
  promptProgressFromHistory, userActionFromEnvelope, waitAbortResult,
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
      } else if (message.method === 'workspace.list') {
        response.end(JSON.stringify({
          type: 'server-response', rpcId: message.rpcId,
          result: { ok: true, value: { items: [{
            workspaceId: 'w1', path: '/work', title: 'Project', sessionIds: ['s1'], createdAt: 1, updatedAt: 2,
          }], archivedSessionIds: ['archived'] } },
        }))
      } else if (message.method === 'agentPreset.list') {
        response.end(JSON.stringify({
          type: 'server-response', rpcId: message.rpcId,
          result: { ok: true, value: { presets: [{ id: 'safe', trust: 'system', isDefault: true }], authorable: false, hasDocument: true } },
        }))
      } else if (message.method === 'session.search') {
        if (message.payload.query === 'disabled') {
          response.end(JSON.stringify({
            type: 'server-response', rpcId: message.rpcId,
            result: { ok: false, error: { code: 'internal', message: 'session search is disabled: index openAt never', details: {} } },
          }))
          return
        }
        response.end(JSON.stringify({
          type: 'server-response', rpcId: message.rpcId,
          result: { ok: true, value: { items: [{ sessionId: 's1', snippet: 'match' }], hasMore: false } },
        }))
      } else if (message.method === 'session.fork') {
        response.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { sessionId: 'fork-1' } } }))
      } else if (message.method === 'session.rename') {
        response.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { title: 'New', seq: 11 } } }))
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
      sessionId: 's1', parentSessionId: null, origin: null,
      title: 'Visible session', running: false, blank: false, cwd: '/work',
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

  it('continues the exact session id and creates only in an explicit workspace', async () => {
    const client = new DshClient({ baseUrl: origin })
    const prompt = await client.prompt('s1', 'follow-up', { mode: 'steer' })
    assert.equal(typeof prompt.promptRpcId, 'string')
    assert.equal(requests.at(-1).message.method, 'session.prompt')
    assert.deepEqual(requests.at(-1).message.payload, {
      sessionId: 's1', mode: 'steer', content: [{ type: 'text', text: 'follow-up' }],
    })
    await client.createSession({ workspaceId: 'w1' })
    assert.equal(requests.at(-1).message.method, 'session.create')
    assert.deepEqual(requests.at(-1).message.payload, { workspaceId: 'w1' })
  })

  it('answers an exact pending approval through the response carrier', async () => {
    const client = new DshClient({ baseUrl: origin })
    const result = await client.respondApproval({
      sessionId: 's1', rpcId: 'rpc-approval-1', approvalId: 'approval-1', outcome: 'rejected',
    })
    assert.deepEqual(result, { accepted: true, state: 'resolved', outcome: 'rejected' })
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

  it('answers and cancels exact question requests', async () => {
    const client = new DshClient({ baseUrl: origin })
    const answered = await client.respondQuestion({
      sessionId: 's1', rpcId: 'rpc-question-1', answers: [{ id: 'q1', selected: ['Yes'] }],
    })
    assert.equal(answered.state, 'resolved')
    assert.deepEqual(requests.at(-1).message, {
      type: 'client-response', rpcId: 'rpc-question-1',
      result: { ok: true, value: { sessionId: 's1', answer: { answers: [{ id: 'q1', selected: ['Yes'] }] } } },
    })
    const cancelled = await client.cancelQuestion({ rpcId: 'rpc-question-2', message: 'No answer' })
    assert.equal(cancelled.state, 'resolved')
    assert.deepEqual(requests.at(-1).message.result, {
      ok: false, error: { code: 'cancelled', message: 'No answer', details: {} },
    })
  })

  it('discovers workspaces, presets, sessions and safe session mutations', async () => {
    const client = new DshClient({ baseUrl: origin })
    assert.equal((await client.listWorkspaces()).workspaces[0].workspaceId, 'w1')
    assert.equal((await client.listAgentPresets()).presets[0].id, 'safe')
    assert.equal((await client.getSession('s1')).sessionId, 's1')
    assert.equal((await client.searchSessions('match')).matches[0].sessionId, 's1')
    await assert.rejects(() => client.searchSessions('disabled'), error => error.code === 'search-disabled')
    assert.equal((await client.renameSession('s1', 'New')).seq, 11)
    assert.equal((await client.forkSession('s1', { atSeq: 9 })).sessionId, 'fork-1')
    assert.deepEqual(requests.at(-1).message.payload, { sessionId: 's1', atSeq: 9 })
  })
})

describe('history compaction', () => {
  it('drops chunks and keeps message-level text and finish reason', () => {
    const summary = summarizeHistoryValue({
      hasMore: false,
      events: [
        { event: { type: 'assistant/chunk', seq: 1, data: { chunk: 'x' } } },
        { event: { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: 'question' }], source: { kind: 'user', rpcId: 'prompt-1' } } } },
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

  it('returns a backward cursor, bounds text, and filters old turns', () => {
    const summary = summarizeHistoryValue({
      hasMore: true,
      events: [
        { event: { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'old answer' }] } } } },
        { event: { type: 'user/message', seq: 10, data: { message: { content: [{ type: 'text', text: 'new question' }] } } } },
        { event: { type: 'tool/call', seq: 11, data: { turn: 2, step: 1, callId: 'c1', name: 'shell', arguments: '123456' } } },
      ],
    }, { afterSeq: 2, includeTools: true, maxChars: 5, maxToolChars: 4 })
    assert.equal(summary.firstSeq, 2)
    assert.equal(summary.nextBeforeSeq, 2)
    assert.equal(summary.finalResponse, '')
    assert.equal(summary.messages[0].text, 'new …')
    assert.equal(summary.toolEvents[0].arguments, '123…')
  })

  it('keeps exact identities for approval and question handoff', () => {
    const approval = userActionFromEnvelope({
      rpcId: 'rpc-a', payload: { type: 'approval/requested', sessionId: 's1', approvalId: 'a1', toolName: 'shell', reason: 'write' },
    }, 's1', 8, 100)
    assert.equal(approval.approval.rpcId, 'rpc-a')
    assert.equal(approval.approval.approvalId, 'a1')
    assert.equal(approval.approval.mayBeStale, true)
    const question = userActionFromEnvelope({
      rpcId: 'rpc-q', payload: { type: 'question/requested', sessionId: 's1', questions: [{ id: 'q1', question: 'Continue?' }] },
    }, 's1', 9, 101)
    assert.equal(question.question.rpcId, 'rpc-q')
    assert.equal(question.question.questions[0].id, 'q1')
  })

  it('returns immediately when wait is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = new DshClient({ baseUrl: 'http://127.0.0.1:1' })
    assert.deepEqual(await client.wait('s1', { signal: controller.signal }), {
      state: 'cancelled', lastSeq: -1, recentEvents: [],
    })
  })

  it('tracks the exact queued prompt through its completed turn', () => {
    const complete = promptProgressFromHistory({ events: [
      { event: { type: 'turn/end', seq: 4, data: {} } },
      { event: { type: 'user/message', seq: 5, data: { source: { kind: 'user', rpcId: 'prompt-target' } } } },
      { event: { type: 'assistant/message', seq: 6, data: {} } },
      { event: { type: 'turn/end', seq: 7, data: {} } },
    ] }, 'prompt-target')
    assert.deepEqual(complete, { seen: true, completed: true, promptSeq: 5, lastSeq: 7 })
    const queued = promptProgressFromHistory({ events: [
      { event: { type: 'user/message', seq: 8, data: { source: { kind: 'user', rpcId: 'prompt-target' } } } },
    ] }, 'prompt-target')
    assert.equal(queued.completed, false)
  })
})
