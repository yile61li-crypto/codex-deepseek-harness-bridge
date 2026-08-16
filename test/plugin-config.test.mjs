import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')

test('starts the MCP server without a plugin-root working-directory override', async () => {
  const config = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'))
  const server = config.mcpServers?.['deepseek-harness']

  assert.equal(typeof server, 'object')
  assert.equal('cwd' in server, false)
  assert.deepEqual(server.args, ['${PLUGIN_ROOT}/scripts/server.mjs'])
})
