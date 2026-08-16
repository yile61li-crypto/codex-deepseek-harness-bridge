import { spawn as nodeSpawn } from 'node:child_process'
import { chmod, open, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DshClient, normalizeBaseUrl } from './dsh-client.mjs'

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 250
const MAX_RUNTIME_ARGS = 128
const MAX_RUNTIME_ARG_LENGTH = 16_384
const RESERVED_RUNTIME_ARGS = new Set(['web', '--host', '--port'])

export class DshRuntimeError extends Error {
  constructor(message, { code = 'runtime-error', details, cause } = {}) {
    super(message, { cause })
    this.name = 'DshRuntimeError'
    this.code = code
    this.details = details
  }
}

function runtimeErrorFromAbort(signal) {
  const reason = signal?.reason
  if (reason instanceof DshRuntimeError) return reason
  return new DshRuntimeError('Waiting for the DeepSeek Harness runtime was cancelled', {
    code: 'cancelled', cause: reason,
  })
}

function checkedString(value, name, { allowUndefined = false } = {}) {
  if ((value === undefined || value === '') && allowUndefined) return undefined
  if (typeof value !== 'string' || value === '' || value.trim() !== value || value.includes('\0')) {
    throw new DshRuntimeError(`${name} must be a non-empty, trimmed string without NUL bytes`, {
      code: 'invalid-runtime-config', details: { name },
    })
  }
  return value
}

function parseArgs(value) {
  if (value === undefined || value === '') return []
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch (cause) {
    throw new DshRuntimeError('DSH_RUNTIME_ARGS_JSON must be valid JSON', {
      code: 'invalid-runtime-config', details: { name: 'DSH_RUNTIME_ARGS_JSON' }, cause,
    })
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_RUNTIME_ARGS) {
    throw new DshRuntimeError(`DSH_RUNTIME_ARGS_JSON must be an array of at most ${MAX_RUNTIME_ARGS} strings`, {
      code: 'invalid-runtime-config', details: { name: 'DSH_RUNTIME_ARGS_JSON' },
    })
  }
  return parsed.map((value, index) => {
    const argument = checkedString(value, `DSH_RUNTIME_ARGS_JSON[${index}]`)
    if (argument.length > MAX_RUNTIME_ARG_LENGTH) {
      throw new DshRuntimeError(`DSH_RUNTIME_ARGS_JSON[${index}] is too long`, {
        code: 'invalid-runtime-config', details: { name: 'DSH_RUNTIME_ARGS_JSON', index },
      })
    }
    if (RESERVED_RUNTIME_ARGS.has(argument) || argument.startsWith('--host=') || argument.startsWith('--port=')) {
      throw new DshRuntimeError(`DSH_RUNTIME_ARGS_JSON[${index}] must not override the managed web host or port`, {
        code: 'invalid-runtime-config', details: { name: 'DSH_RUNTIME_ARGS_JSON', index, value: argument },
      })
    }
    return argument
  })
}

function runtimeEndpoint(value) {
  let url
  try {
    url = normalizeBaseUrl(value)
  } catch (cause) {
    throw new DshRuntimeError('DSH_WEB_URL must be a safe loopback HTTP URL', {
      code: 'invalid-runtime-config', details: { name: 'DSH_WEB_URL' }, cause,
    })
  }
  const port = url.port === '' ? 80 : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new DshRuntimeError('DSH_WEB_URL must contain a valid TCP port', {
      code: 'invalid-runtime-config', details: { name: 'DSH_WEB_URL' },
    })
  }
  return { url: url.origin, port }
}

async function defaultDependencyBin() {
  try {
    return fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/lib/bin.js'))
  } catch (cause) {
    throw new DshRuntimeError('Cannot resolve the bundled @deepseek-ai/dsh CLI', {
      code: 'runtime-dependency-missing',
      details: { package: '@deepseek-ai/dsh', entry: 'lib/bin.js' },
      cause,
    })
  }
}

export async function resolveRuntimeLaunch({
  env = process.env,
  baseUrl = env.DSH_WEB_URL ?? 'http://127.0.0.1:3080',
  resolveDependencyBin = defaultDependencyBin,
} = {}) {
  const endpoint = runtimeEndpoint(baseUrl)
  const configuredCommand = checkedString(env.DSH_RUNTIME_COMMAND, 'DSH_RUNTIME_COMMAND', { allowUndefined: true })
  const configuredArgs = parseArgs(env.DSH_RUNTIME_ARGS_JSON)
  const configuredCwd = checkedString(env.DSH_RUNTIME_CWD, 'DSH_RUNTIME_CWD', { allowUndefined: true })
  if (configuredCwd !== undefined && !isAbsolute(configuredCwd)) {
    throw new DshRuntimeError('DSH_RUNTIME_CWD must be an absolute path', {
      code: 'invalid-runtime-config', details: { name: 'DSH_RUNTIME_CWD', value: configuredCwd },
    })
  }
  const cwd = configuredCwd ?? join(homedir(), '.deepseek-harness-bridge', 'runtime-workspace')

  let command
  let args
  let commandMode
  if (configuredCommand !== undefined) {
    command = configuredCommand
    args = configuredArgs
    commandMode = 'configured'
  } else {
    command = process.execPath
    args = [checkedString(await resolveDependencyBin(), '@deepseek-ai/dsh lib/bin.js'), ...configuredArgs]
    commandMode = 'dependency'
  }
  args = [...args, 'web', '--host', '127.0.0.1', '--port', String(endpoint.port)]
  return { ...endpoint, command, args, cwd, commandMode }
}

async function defaultPrepareLog(logPath) {
  const logDirectory = dirname(logPath)
  await mkdir(logDirectory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(logDirectory, 0o700)
  const handle = await open(logPath, 'a', 0o600)
  try {
    if (process.platform !== 'win32') await handle.chmod(0o600)
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
  return { fd: handle.fd, close: () => handle.close() }
}

function delay(milliseconds, signal) {
  if (signal?.aborted === true) return Promise.reject(runtimeErrorFromAbort(signal))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    function done() {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    function abort() {
      clearTimeout(timer)
      reject(runtimeErrorFromAbort(signal))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function raceSignal(promise, signal) {
  if (signal === undefined) return Promise.resolve(promise)
  if (signal.aborted) return Promise.reject(runtimeErrorFromAbort(signal))
  return new Promise((resolve, reject) => {
    const abort = () => reject(runtimeErrorFromAbort(signal))
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

function processOutcome(child) {
  let settled = false
  let current
  const promise = new Promise(resolve => {
    const settle = value => {
      if (settled) return
      settled = true
      current = value
      resolve(value)
    }
    child.once?.('error', error => settle({ kind: 'error', error }))
    child.once?.('exit', (code, signal) => settle({ kind: 'exit', code, signal }))
  })
  return { promise, get current() { return current } }
}

function publicState({ reachable, url, owned }) {
  const spawned = owned?.alive === true
  return {
    reachable,
    baseUrl: url,
    url,
    pid: spawned && Number.isInteger(owned.child?.pid) ? owned.child.pid : null,
    logPath: spawned ? owned.logPath : null,
    startMode: reachable ? (spawned ? 'spawned' : 'existing') : (spawned ? 'spawned' : null),
    commandMode: spawned ? owned.commandMode : null,
  }
}

export class DshRuntimeManager {
  #ensuring
  #owned

  constructor({
    baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080',
    env = process.env,
    probe,
    spawn = nodeSpawn,
    resolveDependencyBin = defaultDependencyBin,
    prepareLog = defaultPrepareLog,
    prepareCwd = cwd => mkdir(cwd, { recursive: true }),
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    logPath,
  } = {}) {
    const endpoint = runtimeEndpoint(baseUrl)
    if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 100 || startupTimeoutMs > 300_000) {
      throw new DshRuntimeError('startupTimeoutMs must be an integer from 100 to 300000', { code: 'invalid-runtime-config' })
    }
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > startupTimeoutMs) {
      throw new DshRuntimeError('pollIntervalMs must be a positive integer no greater than startupTimeoutMs', { code: 'invalid-runtime-config' })
    }
    this.baseUrl = endpoint.url
    this.port = endpoint.port
    this.env = env
    this.spawn = spawn
    this.resolveDependencyBin = resolveDependencyBin
    this.prepareLog = prepareLog
    this.prepareCwd = prepareCwd
    this.startupTimeoutMs = startupTimeoutMs
    this.pollIntervalMs = pollIntervalMs
    const configuredLogDir = checkedString(env.DSH_RUNTIME_LOG_DIR, 'DSH_RUNTIME_LOG_DIR', { allowUndefined: true })
    if (configuredLogDir !== undefined && !isAbsolute(configuredLogDir)) {
      throw new DshRuntimeError('DSH_RUNTIME_LOG_DIR must be an absolute path', {
        code: 'invalid-runtime-config', details: { name: 'DSH_RUNTIME_LOG_DIR', value: configuredLogDir },
      })
    }
    this.logPath = logPath ?? join(
      configuredLogDir ?? join(homedir(), '.deepseek-harness-bridge', 'logs'),
      `dsh-web-${endpoint.port}.log`,
    )
    this.probe = probe ?? (async ({ signal }) => {
      const client = new DshClient({ baseUrl: this.baseUrl, timeoutMs: Math.min(2_000, this.startupTimeoutMs) })
      await client.health({ signal })
      return true
    })
  }

  async #reachable(signal) {
    try {
      const result = await raceSignal(this.probe({ url: this.baseUrl, signal }), signal)
      return result === true || result?.reachable === true
    } catch (error) {
      if (signal?.aborted === true) throw runtimeErrorFromAbort(signal)
      return false
    }
  }

  async status({ signal } = {}) {
    if (signal?.aborted === true) throw runtimeErrorFromAbort(signal)
    const reachable = await this.#reachable(signal)
    return publicState({ reachable, url: this.baseUrl, owned: this.#owned })
  }

  ensure({ signal } = {}) {
    if (signal?.aborted === true) return Promise.reject(runtimeErrorFromAbort(signal))
    if (this.#ensuring === undefined) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new DshRuntimeError(
        `DeepSeek Harness did not become reachable within ${this.startupTimeoutMs}ms`,
        { code: 'runtime-start-timeout', details: { timeoutMs: this.startupTimeoutMs, url: this.baseUrl } },
      )), this.startupTimeoutMs)
      const operation = this.#ensureOnce(controller.signal).finally(() => {
        clearTimeout(timeout)
        if (this.#ensuring === operation) this.#ensuring = undefined
      })
      this.#ensuring = operation
    }
    return raceSignal(this.#ensuring, signal)
  }

  async #ensureOnce(signal) {
    if (await this.#reachable(signal)) {
      return publicState({ reachable: true, url: this.baseUrl, owned: this.#owned })
    }

    const launch = await raceSignal(resolveRuntimeLaunch({
      env: this.env,
      baseUrl: this.baseUrl,
      resolveDependencyBin: this.resolveDependencyBin,
    }), signal)
    let log
    let child
    try {
      log = await raceSignal(this.prepareLog(this.logPath), signal)
      await raceSignal(this.prepareCwd(launch.cwd), signal)
      child = this.spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: this.env,
        detached: true,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
      })
    } catch (cause) {
      throw cause instanceof DshRuntimeError ? cause : new DshRuntimeError('Failed to start DeepSeek Harness', {
        code: 'runtime-spawn-failed', details: { commandMode: launch.commandMode, logPath: this.logPath }, cause,
      })
    } finally {
      await log?.close?.().catch?.(() => {})
    }

    const outcome = processOutcome(child)
    const owned = {
      alive: true,
      child,
      logPath: this.logPath,
      commandMode: launch.commandMode,
    }
    this.#owned = owned
    void outcome.promise.then(() => { owned.alive = false })

    try {
      while (true) {
        if (await this.#reachable(signal)) {
          if (outcome.current !== undefined) {
            this.#owned = undefined
            return publicState({ reachable: true, url: this.baseUrl })
          }
          child.unref?.()
          return publicState({ reachable: true, url: this.baseUrl, owned })
        }
        if (outcome.current !== undefined) {
          const finalReachable = await this.#reachable(signal)
          if (finalReachable) {
            this.#owned = undefined
            return publicState({ reachable: true, url: this.baseUrl })
          }
          const details = outcome.current.kind === 'exit'
            ? { code: outcome.current.code, signal: outcome.current.signal }
            : { error: String(outcome.current.error) }
          throw new DshRuntimeError('DeepSeek Harness exited before becoming reachable', {
            code: 'runtime-exited', details: { ...details, logPath: this.logPath },
          })
        }
        await Promise.race([delay(this.pollIntervalMs, signal), outcome.promise])
      }
    } catch (error) {
      if (owned.alive) {
        try { child.kill?.() } catch { /* best-effort termination of this manager's child only */ }
        owned.alive = false
        if (this.#owned === owned) this.#owned = undefined
      }
      if (signal.aborted) throw runtimeErrorFromAbort(signal)
      throw error
    }
  }
}
