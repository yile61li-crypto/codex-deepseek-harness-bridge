import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import {
  DshRuntimeError, DshRuntimeManager, resolveRuntimeLaunch,
} from '../src/dsh-runtime.mjs'

function childProcess(pid = 42) {
  const child = new EventEmitter()
  child.pid = pid
  child.kills = 0
  child.unrefs = 0
  child.kill = () => { child.kills += 1; return true }
  child.unref = () => { child.unrefs += 1 }
  return child
}

function logFixture() {
  return { fd: 'log-fd', close: async () => {} }
}

describe('runtime launch configuration', () => {
  it('uses a configured command without a shell and appends the fixed loopback endpoint', async () => {
    const cwd = resolve('runtime-work')
    const launch = await resolveRuntimeLaunch({
      env: {
        DSH_RUNTIME_COMMAND: 'custom-dsh',
        DSH_RUNTIME_ARGS_JSON: JSON.stringify(['--profile', 'safe']),
        DSH_RUNTIME_CWD: cwd,
      },
      baseUrl: 'http://127.0.0.1:43123',
    })
    assert.deepEqual(launch, {
      url: 'http://127.0.0.1:43123', port: 43123,
      command: 'custom-dsh',
      args: ['--profile', 'safe', 'web', '--host', '127.0.0.1', '--port', '43123'],
      cwd,
      commandMode: 'configured',
    })
  })

  it('uses Node and the packaged DSH bin by default', async () => {
    const launch = await resolveRuntimeLaunch({
      env: {},
      resolveDependencyBin: async () => resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),
    })
    assert.equal(launch.command, process.execPath)
    assert.equal(launch.commandMode, 'dependency')
    assert.equal(launch.cwd.endsWith('.deepseek-harness-bridge\\runtime-workspace')
      || launch.cwd.endsWith('.deepseek-harness-bridge/runtime-workspace'), true)
    assert.deepEqual(launch.args.slice(-6), [
      resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),
      'web', '--host', '127.0.0.1', '--port', '3080',
    ])
  })

  it('strictly rejects malformed or endpoint-overriding configuration', async () => {
    const invalid = [
      { DSH_RUNTIME_COMMAND: ' custom-dsh' },
      { DSH_RUNTIME_ARGS_JSON: '{}' },
      { DSH_RUNTIME_ARGS_JSON: '[1]' },
      { DSH_RUNTIME_ARGS_JSON: '["--host=0.0.0.0"]' },
      { DSH_RUNTIME_CWD: 'relative/path' },
    ]
    for (const env of invalid) {
      await assert.rejects(
        () => resolveRuntimeLaunch({ env, resolveDependencyBin: async () => '/dsh/lib/bin.js' }),
        error => error instanceof DshRuntimeError && error.code === 'invalid-runtime-config',
      )
    }
  })
})

describe('DshRuntimeManager', () => {
  it('reuses an existing external runtime without spawning or terminating anything', async () => {
    let spawnCalls = 0
    const manager = new DshRuntimeManager({
      probe: async () => true,
      spawn: () => { spawnCalls += 1; return childProcess() },
      prepareLog: async () => logFixture(),
      prepareCwd: async () => {},
      startupTimeoutMs: 500,
      pollIntervalMs: 1,
    })
    assert.deepEqual(await manager.ensure(), {
      reachable: true,
      baseUrl: 'http://127.0.0.1:3080',
      url: 'http://127.0.0.1:3080',
      pid: null,
      logPath: null,
      startMode: 'existing',
      commandMode: null,
    })
    assert.equal(spawnCalls, 0)
  })

  it('starts a configured runtime with safe spawn options and reports ownership', async () => {
    const probes = [false, false, true]
    const calls = []
    const child = childProcess(77)
    const manager = new DshRuntimeManager({
      env: { DSH_RUNTIME_COMMAND: 'custom-dsh', DSH_RUNTIME_ARGS_JSON: '[]' },
      probe: async () => probes.shift() ?? true,
      spawn: (...args) => { calls.push(args); return child },
      prepareLog: async () => logFixture(),
      prepareCwd: async () => {},
      logPath: resolve('runtime.log'),
      startupTimeoutMs: 500,
      pollIntervalMs: 1,
    })
    const result = await manager.ensure()
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0][1], ['web', '--host', '127.0.0.1', '--port', '3080'])
    assert.equal(calls[0][2].shell, false)
    assert.equal(calls[0][2].detached, true)
    assert.equal(calls[0][2].windowsHide, true)
    assert.deepEqual(result, {
      reachable: true,
      baseUrl: 'http://127.0.0.1:3080',
      url: 'http://127.0.0.1:3080',
      pid: 77,
      logPath: resolve('runtime.log'),
      startMode: 'spawned',
      commandMode: 'configured',
    })
    assert.equal(child.kills, 0)
    assert.equal(child.unrefs, 1)
  })

  it('coalesces concurrent ensure calls into one probe/start operation', async () => {
    let releaseProbe
    let probeCalls = 0
    let spawnCalls = 0
    const manager = new DshRuntimeManager({
      env: { DSH_RUNTIME_COMMAND: 'custom-dsh' },
      probe: async () => {
        probeCalls += 1
        if (probeCalls === 1) return false
        return new Promise(resolve => { releaseProbe = resolve })
      },
      spawn: () => { spawnCalls += 1; return childProcess(88) },
      prepareLog: async () => logFixture(),
      prepareCwd: async () => {},
      startupTimeoutMs: 500,
      pollIntervalMs: 1,
    })
    const first = manager.ensure()
    const second = manager.ensure()
    while (releaseProbe === undefined) await new Promise(resolve => setImmediate(resolve))
    releaseProbe(true)
    const [a, b] = await Promise.all([first, second])
    assert.deepEqual(a, b)
    assert.equal(spawnCalls, 1)
  })

  it('cancels only one caller while the shared reachability check continues', async () => {
    let releaseProbe
    const manager = new DshRuntimeManager({
      probe: async () => new Promise(resolve => { releaseProbe = resolve }),
      spawn: () => { throw new Error('must not spawn') },
      startupTimeoutMs: 500,
      pollIntervalMs: 1,
    })
    const abort = new AbortController()
    const cancelled = manager.ensure({ signal: abort.signal })
    const shared = manager.ensure()
    abort.abort(new Error('caller stopped waiting'))
    await assert.rejects(cancelled, error => error.code === 'cancelled')
    releaseProbe(true)
    assert.equal((await shared).startMode, 'existing')
  })

  it('bounds startup polling and terminates only the child it spawned', async () => {
    const child = childProcess(99)
    const manager = new DshRuntimeManager({
      env: { DSH_RUNTIME_COMMAND: 'custom-dsh' },
      probe: async () => false,
      spawn: () => child,
      prepareLog: async () => logFixture(),
      prepareCwd: async () => {},
      startupTimeoutMs: 100,
      pollIntervalMs: 5,
    })
    await assert.rejects(manager.ensure(), error => error.code === 'runtime-start-timeout')
    assert.equal(child.kills, 1)
  })
})
