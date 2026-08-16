import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const root = new URL('../', import.meta.url)

describe('conversation routing policy', () => {
  it('defaults related work to exact-session continuation', async () => {
    const [skill, server, english, chinese] = await Promise.all([
      readFile(new URL('skills/deepseek-harness/SKILL.md', root), 'utf8'),
      readFile(new URL('scripts/server.mjs', root), 'utf8'),
      readFile(new URL('README.md', root), 'utf8'),
      readFile(new URL('README.zh-CN.md', root), 'utf8'),
    ])

    assert.match(skill, /Default to continuing the exact bound DSH conversation/)
    assert.match(skill, /Do not open a new conversation merely because another tool call is needed/)
    assert.match(skill, /multiple candidates are plausible or relevance is uncertain, ask one short question/)
    assert.match(server, /conversationRouting: 'reuse-related-exact-session'/)
    assert.match(server, /dsh_send for related follow-ups/)
    assert.match(english, /reuse when related, create only at a real boundary/)
    assert.match(chinese, /有关联就续写，只有真正跨越任务边界才新建/)
  })
})
