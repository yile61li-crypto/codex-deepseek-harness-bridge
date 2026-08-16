#!/usr/bin/env node

import { DshClient } from '../src/dsh-client.mjs'

const client = new DshClient()
const [health, sessions, workspaces, presets] = await Promise.all([
  client.health(), client.listSessions(), client.listWorkspaces(), client.listAgentPresets(),
])
const sample = sessions.find(session => !session.blank) ?? sessions[0]
const sampleResult = sample === undefined ? null : await Promise.all([
  client.getModels(sample.sessionId),
  client.history(sample.sessionId, { maxMessages: 1, maxChars: 1_000, includeTools: true, maxToolEvents: 2 }),
]).then(([models, history]) => ({
  sessionId: sample.sessionId,
  modelRoutable: models.routable === true,
  history: {
    firstSeq: history.firstSeq, lastSeq: history.lastSeq, nextBeforeSeq: history.nextBeforeSeq,
    finishReason: history.finishReason, messageCount: history.messages.length,
    toolEventCount: history.toolEvents.length,
  },
}))
process.stdout.write(`${JSON.stringify({
  reachable: health.reachable,
  baseUrl: client.baseUrl.origin,
  reportedHostApiVersion: health.host?.version ?? null,
  sessionCount: sessions.length,
  workspaceCount: workspaces.workspaces.length,
  presetCount: presets.presets.length,
  sample: sampleResult,
}, null, 2)}\n`)
