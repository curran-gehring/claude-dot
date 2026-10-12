import { describe, expect, test } from 'claude-code/testing'

import { callDetail, isConsequential, matchingRule, parseAction } from '../hooks/core/rules'
import { emptyData } from '../hooks/core/data'
import { rulesText } from '../hooks/text'

const CWD = 'C:/Dev/oregano'

describe('callDetail', () => {
  test('a send, reply or forward shows the whole draft', async () => {
    const draft = { to: ['buyer@example.com'], cc: ['ops@example.com'], subject: 'Pallet count', body: 'x'.repeat(500), attachments: ['count.pdf'] }
    const detail = callDetail('mcp__claude_ai_Gmail__send_message', draft)
    for (const part of ['buyer@example.com', 'ops@example.com', 'Pallet count', 'x'.repeat(500), 'count.pdf']) expect(detail).toContain(part)
    expect(callDetail('mcp__claude_ai_ms365__outlook_forward_mail', { to: ['a@example.com'] })).toContain('a@example.com')
  })

  test('a draft past the limit is clipped and says so', async () => {
    const detail = callDetail('mcp__claude_ai_Gmail__reply', { body: 'y'.repeat(10_000) })
    expect(detail.length).toBeLessThanOrEqual(4_000)
    expect(detail.endsWith('…')).toBe(true)
  })

  test('anything else shows its argument, clipped short', async () => {
    expect(callDetail('Bash', { command: 'git push origin main' })).toBe('Bash: git push origin main')
    expect(callDetail('Bash', { command: 'z'.repeat(1_000) }).length).toBeLessThanOrEqual(170)
  })
})

describe('rulesText', () => {
  test('patterns read as code, so Markdown keeps their stars', async () => {
    const data = { ...emptyData(), rules: [
      { id: '1', level: 'when-asked' as const, action: 'mcp__*__*send*' },
      { id: '2', level: 'handoff' as const, action: 'any Amazon account change' },
    ] }
    expect(rulesText(data)).toBe('1. [when-asked] `mcp__*__*send*`\n2. [handoff] any Amazon account change')
  })
})

describe('parseAction', () => {
  test('a tool pattern', async () => {
    expect(parseAction('Bash(git push*)')).toEqual({ tool: 'Bash', arg: 'git push*' })
    expect(parseAction('Edit')).toEqual({ tool: 'Edit', arg: null })
    expect(parseAction('mcp__*__send*')).toEqual({ tool: 'mcp__*__send*', arg: null })
  })

  test('plain words are a description for Auto-review', async () => {
    expect(parseAction('Ask before replying to customers')).toBeNull()
    expect(parseAction('merging pull requests')).toBeNull()
  })
})

describe('matchingRule', () => {
  const rules = [
    { id: 'r1', level: 'allow', action: 'Bash(git push*)' },
    { id: 'r2', level: 'handoff', action: 'Bash(git push --force*)' },
    { id: 'r3', level: 'ask', action: 'mcp__*__send*' },
    { id: 'r4', level: 'ask', action: 'never touch the billing table' },
    { id: 'r5', level: 'when-asked', action: 'Edit(*.env*)' },
  ] as const

  test('the strictest matching pattern wins', async () => {
    expect(matchingRule(rules, 'Bash', { command: 'git push origin main' })?.id).toBe('r1')
    expect(matchingRule(rules, 'Bash', { command: 'git push --force origin main' })?.id).toBe('r2')
  })

  test('tool globs and file paths', async () => {
    expect(matchingRule(rules, 'mcp__claude_ai_Gmail__send_message', {})?.id).toBe('r3')
    expect(matchingRule(rules, 'Edit', { file_path: 'C:/Dev/oregano/.env.local' })?.id).toBe('r5')
    expect(matchingRule(rules, 'Edit', { file_path: 'C:/Dev/oregano/src/a.ts' })).toBeUndefined()
  })

  test('descriptions never match by pattern', async () => {
    expect(matchingRule(rules, 'Bash', { command: 'psql -c "delete from billing"' })).toBeUndefined()
  })
})

describe('isConsequential', () => {
  test('reading is not', async () => {
    expect(isConsequential('Read', { file_path: '/etc/hosts' }, CWD)).toBe(false)
    expect(isConsequential('Grep', { pattern: 'x' }, CWD)).toBe(false)
    expect(isConsequential('Bash', { command: 'git status && git log -5' }, CWD)).toBe(false)
    expect(isConsequential('mcp__claude_ai_Gmail__search_threads', {}, CWD)).toBe(false)
  })

  test('shell commands that publish, destroy or spend are', async () => {
    for (const command of [
      'git push origin main',
      'rm -rf build',
      'git reset --hard HEAD~3',
      'gh pr merge 12 --squash',
      'npm publish',
      'curl -X POST https://api.example.com/charge',
      'Remove-Item -Recurse dist',
      'psql -c "DROP TABLE users"',
      'terraform apply',
    ]) {
      expect({ command, is: isConsequential('Bash', { command }, CWD) }).toEqual({ command, is: true })
    }
  })

  test('edits outside the project or to secrets are', async () => {
    expect(isConsequential('Edit', { file_path: 'C:/Dev/oregano/src/a.ts' }, CWD)).toBe(false)
    expect(isConsequential('Write', { file_path: 'C:/Users/me/.ssh/config' }, CWD)).toBe(true)
    expect(isConsequential('Edit', { file_path: 'C:/Dev/oregano/.env' }, CWD)).toBe(true)
    expect(isConsequential('Edit', { file_path: 'C:\\Dev\\oregano\\src\\b.ts' }, CWD)).toBe(false)
  })

  test('a path that climbs out of the project with .. is outside it', async () => {
    expect(isConsequential('Write', { file_path: 'C:/Dev/oregano/../secrets.txt' }, CWD)).toBe(true)
    expect(isConsequential('Write', { file_path: 'C:\\Dev\\oregano\\src\\..\\..\\other\\a.ts' }, CWD)).toBe(true)
    expect(isConsequential('Edit', { file_path: 'C:/Dev/oregano/src/../lib/./a.ts' }, CWD)).toBe(false)
    expect(isConsequential('Edit', { file_path: 'C:/Dev/oregano-evil/a.ts' }, CWD)).toBe(true)
  })

  test('a relative path is not trusted to be inside', async () => {
    expect(isConsequential('Write', { file_path: 'src/a.ts' }, CWD)).toBe(true)
  })

  test('connector tools that send or change things are, the dot’s own are not', async () => {
    expect(isConsequential('mcp__claude_ai_Gmail__send_message', {}, CWD)).toBe(true)
    expect(isConsequential('mcp__claude_ai_Google_Drive__trash_file', {}, CWD)).toBe(true)
    expect(isConsequential('mcp__dot__note', {}, CWD)).toBe(false)
  })

  test('a connector tool counts as reading only when its name says so', async () => {
    for (const tool of ['mcp__foo__write_file', 'mcp__foo__set_status', 'mcp__foo__move_item', 'mcp__db__run_query', 'mcp__foo__frobnicate', 'mcp__foo__read_and_update']) {
      expect({ tool, is: isConsequential(tool, {}, CWD) }).toEqual({ tool, is: true })
    }
    for (const tool of ['mcp__claude_ai_Gmail__get_thread', 'mcp__claude_ai_Google_Calendar__list_events', 'mcp__claude_ai_Hugging_Face__hub_repo_search', 'mcp__pdfcraft__page_render']) {
      expect({ tool, is: isConsequential(tool, {}, CWD) }).toEqual({ tool, is: false })
    }
  })
})
