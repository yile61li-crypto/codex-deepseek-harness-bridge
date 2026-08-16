import { readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const SCHEMA_VERSION = 1
const PERMISSIONS = Object.freeze([
  'read-only',
  'workspace-write',
  'danger-full-access',
])
const PERMISSION_RANK = new Map(PERMISSIONS.map((permission, index) => [permission, index]))

export class PermissionSettingsError extends Error {
  constructor(message, { code = 'permission-settings-invalid', details, cause } = {}) {
    super(message, { cause })
    this.name = 'PermissionSettingsError'
    this.code = code
    this.details = details
  }
}

function invalidPermission(value, name) {
  if (!PERMISSION_RANK.has(value)) {
    throw new PermissionSettingsError(
      `${name} must be one of: ${PERMISSIONS.join(', ')}`,
      {
        details: { name, supportedPermissions: [...PERMISSIONS] },
      },
    )
  }
  return value
}

function settingsPathFromEnv(env) {
  const configured = env?.DSH_SETTINGS_FILE
  if (configured === undefined || configured === '') {
    return join(homedir(), '.deepseek-harness-bridge', 'settings.json')
  }
  if (typeof configured !== 'string' || configured.trim() !== configured
      || configured.includes('\0') || !isAbsolute(configured)) {
    throw new PermissionSettingsError('DSH_SETTINGS_FILE must be an absolute path', {
      details: { name: 'DSH_SETTINGS_FILE' },
    })
  }
  return configured
}

function capPermission(permission, maximum) {
  return PERMISSION_RANK.get(permission) <= PERMISSION_RANK.get(maximum)
    ? permission
    : maximum
}

function loadPersistedDefault(settingsPath) {
  let source
  try {
    source = readFileSync(settingsPath, 'utf8')
  } catch (cause) {
    if (cause?.code === 'ENOENT') return undefined
    throw new PermissionSettingsError('Could not read the permission settings file', {
      code: 'permission-settings-io',
      details: { settingsPath },
      cause,
    })
  }

  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (cause) {
    throw new PermissionSettingsError('Permission settings must contain valid JSON', {
      details: { settingsPath },
      cause,
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PermissionSettingsError('Permission settings must be a JSON object', {
      details: { settingsPath },
    })
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new PermissionSettingsError(`Permission settings schemaVersion must be ${SCHEMA_VERSION}`, {
      details: { settingsPath, supportedSchemaVersion: SCHEMA_VERSION },
    })
  }
  try {
    return invalidPermission(parsed.defaultPermission, 'defaultPermission')
  } catch (cause) {
    throw new PermissionSettingsError('Permission settings contain an unsupported defaultPermission', {
      details: { settingsPath, supportedPermissions: [...PERMISSIONS] },
      cause,
    })
  }
}

export class PermissionSettings {
  #defaultPermission
  #installationDefault
  #maxPermission
  #operations = Promise.resolve()
  #settingsPath

  constructor({
    env = process.env,
    maxPermission = 'danger-full-access',
    installationDefault = 'read-only',
  } = {}) {
    this.#maxPermission = invalidPermission(maxPermission, 'maxPermission')
    const fallback = invalidPermission(installationDefault, 'installationDefault')
    this.#installationDefault = capPermission(fallback, this.#maxPermission)
    this.#settingsPath = settingsPathFromEnv(env)
    const persisted = loadPersistedDefault(this.#settingsPath)
    this.#defaultPermission = capPermission(
      persisted ?? this.#installationDefault,
      this.#maxPermission,
    )
  }

  get defaultPermission() {
    return this.#defaultPermission
  }

  get settingsPath() {
    return this.#settingsPath
  }

  async refresh() {
    const update = async () => {
      const persisted = loadPersistedDefault(this.#settingsPath)
      const previousDefaultPermission = this.#defaultPermission
      const defaultPermission = capPermission(
        persisted ?? this.#installationDefault,
        this.#maxPermission,
      )
      this.#defaultPermission = defaultPermission
      return {
        defaultPermission,
        previousDefaultPermission,
        persisted: persisted !== undefined,
        settingsPath: this.#settingsPath,
      }
    }

    const result = this.#operations.then(update, update)
    this.#operations = result.then(() => undefined, () => undefined)
    return result
  }

  async setDefault(permission) {
    const effective = capPermission(
      invalidPermission(permission, 'permission'),
      this.#maxPermission,
    )
    const update = async () => {
      const previousDefaultPermission = this.#defaultPermission
      const directory = dirname(this.#settingsPath)
      const temporaryPath = join(
        directory,
        `.${basename(this.#settingsPath)}.${process.pid}.${randomUUID()}.tmp`,
      )
      const serialized = `${JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        defaultPermission: effective,
      }, null, 2)}\n`

      try {
        await mkdir(directory, { recursive: true })
        await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        await rename(temporaryPath, this.#settingsPath)
      } catch (cause) {
        await unlink(temporaryPath).catch(() => {})
        throw new PermissionSettingsError('Could not persist the default permission setting', {
          code: 'permission-settings-io',
          details: { settingsPath: this.#settingsPath },
          cause,
        })
      }

      this.#defaultPermission = effective
      return {
        defaultPermission: effective,
        previousDefaultPermission,
        persisted: true,
        settingsPath: this.#settingsPath,
      }
    }

    const result = this.#operations.then(update, update)
    this.#operations = result.then(() => undefined, () => undefined)
    return result
  }
}
