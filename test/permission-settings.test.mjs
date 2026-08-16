import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  PermissionSettings, PermissionSettingsError,
} from '../src/permission-settings.mjs'

const temporaryDirectories = []

async function fixturePath(name = 'settings.json') {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-permission-settings-'))
  temporaryDirectories.push(directory)
  return join(directory, 'nested', name)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    directory => rm(directory, { recursive: true, force: true }),
  ))
})

describe('PermissionSettings loading', () => {
  it('uses the installation default and the user settings path when no file exists', () => {
    const settings = new PermissionSettings({ env: {}, installationDefault: 'workspace-write' })
    assert.equal(settings.defaultPermission, 'workspace-write')
    assert.equal(settings.settingsPath, join(homedir(), '.deepseek-harness-bridge', 'settings.json'))
    assert.equal(isAbsolute(settings.settingsPath), true)
  })

  it('loads schema version 1 from an absolute override', async () => {
    const settingsPath = await fixturePath()
    await mkdir(dirname(settingsPath), { recursive: true })
    await writeFile(settingsPath, JSON.stringify({
      schemaVersion: 1,
      defaultPermission: 'danger-full-access',
    }))
    const settings = new PermissionSettings({
      env: { DSH_SETTINGS_FILE: settingsPath },
      maxPermission: 'danger-full-access',
    })
    assert.equal(settings.settingsPath, settingsPath)
    assert.equal(settings.defaultPermission, 'danger-full-access')
  })

  it('rejects relative override paths and unsupported constructor permissions', () => {
    const invalid = [
      () => new PermissionSettings({ env: { DSH_SETTINGS_FILE: 'settings.json' } }),
      () => new PermissionSettings({ env: {}, maxPermission: 'root' }),
      () => new PermissionSettings({ env: {}, installationDefault: 'prompt' }),
    ]
    for (const construct of invalid) {
      assert.throws(construct, error => (
        error instanceof PermissionSettingsError
        && error.code === 'permission-settings-invalid'
      ))
    }
  })

  it('fails closed on corrupt, unsupported, or unreadable settings', async () => {
    const fixtures = [
      '{not-json',
      JSON.stringify([]),
      JSON.stringify({ schemaVersion: 2, defaultPermission: 'read-only' }),
      JSON.stringify({ schemaVersion: 1, defaultPermission: 'root' }),
    ]
    for (const source of fixtures) {
      const settingsPath = await fixturePath()
      await mkdir(dirname(settingsPath), { recursive: true })
      await writeFile(settingsPath, source)
      assert.throws(
        () => new PermissionSettings({ env: { DSH_SETTINGS_FILE: settingsPath } }),
        error => error instanceof PermissionSettingsError
          && error.code === 'permission-settings-invalid'
          && !error.message.includes(source),
      )
    }

    const directoryPath = await mkdtemp(join(tmpdir(), 'dsh-permission-directory-'))
    temporaryDirectories.push(directoryPath)
    assert.throws(
      () => new PermissionSettings({ env: { DSH_SETTINGS_FILE: directoryPath } }),
      error => error instanceof PermissionSettingsError
        && error.code === 'permission-settings-io',
    )
  })

  it('caps both installation and persisted defaults at maxPermission', async () => {
    const fallbackPath = await fixturePath()
    const fallback = new PermissionSettings({
      env: { DSH_SETTINGS_FILE: fallbackPath },
      maxPermission: 'workspace-write',
      installationDefault: 'danger-full-access',
    })
    assert.equal(fallback.defaultPermission, 'workspace-write')

    const persistedPath = await fixturePath()
    await mkdir(dirname(persistedPath), { recursive: true })
    await writeFile(persistedPath, JSON.stringify({
      schemaVersion: 1,
      defaultPermission: 'danger-full-access',
    }))
    const persisted = new PermissionSettings({
      env: { DSH_SETTINGS_FILE: persistedPath },
      maxPermission: 'read-only',
    })
    assert.equal(persisted.defaultPermission, 'read-only')
  })
})

describe('PermissionSettings updates', () => {
  it('refreshes changes from another instance and falls back after deletion', async () => {
    const settingsPath = await fixturePath()
    const writer = new PermissionSettings({
      env: { DSH_SETTINGS_FILE: settingsPath },
      maxPermission: 'danger-full-access',
      installationDefault: 'read-only',
    })
    const reader = new PermissionSettings({
      env: { DSH_SETTINGS_FILE: settingsPath },
      maxPermission: 'workspace-write',
      installationDefault: 'danger-full-access',
    })

    await writer.setDefault('read-only')
    assert.deepEqual(await reader.refresh(), {
      defaultPermission: 'read-only',
      previousDefaultPermission: 'workspace-write',
      persisted: true,
      settingsPath,
    })

    await writer.setDefault('danger-full-access')
    assert.equal((await reader.refresh()).defaultPermission, 'workspace-write')
    assert.equal(reader.defaultPermission, 'workspace-write')

    await rm(settingsPath)
    assert.deepEqual(await reader.refresh(), {
      defaultPermission: 'workspace-write',
      previousDefaultPermission: 'workspace-write',
      persisted: false,
      settingsPath,
    })
  })

  it('fails closed on a corrupt refresh without changing memory', async () => {
    const settingsPath = await fixturePath()
    const writer = new PermissionSettings({ env: { DSH_SETTINGS_FILE: settingsPath } })
    const reader = new PermissionSettings({ env: { DSH_SETTINGS_FILE: settingsPath } })

    await writer.setDefault('workspace-write')
    await reader.refresh()
    await writeFile(settingsPath, '{not-json')

    await assert.rejects(
      reader.refresh(),
      error => error instanceof PermissionSettingsError
        && error.code === 'permission-settings-invalid',
    )
    assert.equal(reader.defaultPermission, 'workspace-write')
  })

  it('atomically persists a default and immediately updates memory', async () => {
    const settingsPath = await fixturePath()
    const settings = new PermissionSettings({
      env: { DSH_SETTINGS_FILE: settingsPath },
      installationDefault: 'read-only',
    })

    assert.deepEqual(await settings.setDefault('workspace-write'), {
      defaultPermission: 'workspace-write',
      previousDefaultPermission: 'read-only',
      persisted: true,
      settingsPath,
    })
    assert.equal(settings.defaultPermission, 'workspace-write')
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), {
      schemaVersion: 1,
      defaultPermission: 'workspace-write',
    })
    assert.deepEqual(await readdir(dirname(settingsPath)), ['settings.json'])
  })

  it('caps requested defaults and serializes concurrent updates in call order', async () => {
    const settingsPath = await fixturePath()
    const settings = new PermissionSettings({
      env: { DSH_SETTINGS_FILE: settingsPath },
      maxPermission: 'workspace-write',
    })

    const [first, second] = await Promise.all([
      settings.setDefault('danger-full-access'),
      settings.setDefault('read-only'),
    ])
    assert.equal(first.defaultPermission, 'workspace-write')
    assert.equal(first.previousDefaultPermission, 'read-only')
    assert.equal(second.previousDefaultPermission, 'workspace-write')
    assert.equal(second.defaultPermission, 'read-only')
    assert.equal(settings.defaultPermission, 'read-only')
    assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).defaultPermission, 'read-only')
  })

  it('rejects unsupported updates without changing memory or creating a file', async () => {
    const settingsPath = await fixturePath()
    const settings = new PermissionSettings({ env: { DSH_SETTINGS_FILE: settingsPath } })
    await assert.rejects(
      settings.setDefault('prompt'),
      error => error instanceof PermissionSettingsError
        && error.code === 'permission-settings-invalid',
    )
    assert.equal(settings.defaultPermission, 'read-only')
    await assert.rejects(readFile(settingsPath), error => error.code === 'ENOENT')
  })

  it('keeps the in-memory default unchanged when atomic persistence fails', async () => {
    const settingsPath = await fixturePath()
    await mkdir(dirname(settingsPath), { recursive: true })
    await writeFile(settingsPath, JSON.stringify({
      schemaVersion: 1,
      defaultPermission: 'workspace-write',
    }))
    const settings = new PermissionSettings({ env: { DSH_SETTINGS_FILE: settingsPath } })
    const settingsDirectory = dirname(settingsPath)
    await rm(settingsDirectory, { recursive: true })
    await writeFile(settingsDirectory, 'blocks directory recreation')

    await assert.rejects(
      settings.setDefault('danger-full-access'),
      error => error instanceof PermissionSettingsError
        && error.code === 'permission-settings-io',
    )
    assert.equal(settings.defaultPermission, 'workspace-write')
  })
})
