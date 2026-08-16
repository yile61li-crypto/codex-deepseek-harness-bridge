#!/usr/bin/env node

import { DshClient } from '../src/dsh-client.mjs'

const client = new DshClient()
const sessions = await client.listSessions()
process.stdout.write(`${JSON.stringify({
  reachable: true,
  baseUrl: client.baseUrl.origin,
  sessionCount: sessions.length,
  sessions,
}, null, 2)}\n`)
