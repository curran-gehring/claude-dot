import { describe, expect, test } from 'claude-code/testing'

import { parseCommand } from '../hooks/core/command'
import { decodeData, emptyData } from '../hooks/core/data'
import { parseReport } from '../hooks/core/report'
import { parseVerdict } from '../hooks/core/review'

describe('parseVerdict', () => {
  test('reads the reviewer’s JSON, fenced or bare', async () => {
    expect(parseVerdict('{"verdict":"ask","reason":"pushes to main"}')).toEqual({ verdict: 'ask', reason: 'pushes to main' })
    expect(parseVerdict('Sure.\n```json\n{"verdict": "run", "reason": "asked for it"}\n```')).toEqual({ verdict: 'run', reason: 'asked for it' })
  })

  test('anything else is no verdict', async () => {
    expect(parseVerdict('{"verdict":"maybe","reason":"x"}')).toBeNull()
    expect(parseVerdict('run it')).toBeNull()
    expect(parseVerdict('{"verdict":"run"}')).toBeNull()
  })
})

describe('parseReport', () => {
  test('takes the last JSON block of an agent’s answer', async () => {
    const answer = [
      'I checked CI.',
      '```json',
      '{"summary":"main is red: 2 failing tests","needsYou":true,',
      ' "inbox":[{"kind":"question","title":"Revert #41?","body":"It broke login."}],',
      ' "notes":["CI runs on GitHub Actions"]}',
      '```',
    ].join('\n')
    expect(parseReport(answer)).toEqual({
      summary: 'main is red: 2 failing tests',
      needsYou: true,
      inbox: [{ kind: 'question', title: 'Revert #41?', body: 'It broke login.' }],
      notes: ['CI runs on GitHub Actions'],
    })
  })

  test('defaults the optional parts', async () => {
    expect(parseReport('{"summary":"all quiet"}')).toEqual({ summary: 'all quiet', needsYou: false, inbox: [], notes: [] })
  })

  test('an oversized report is held to its limits, and says what it dropped', async () => {
    const item = (at: number) => ({ kind: 'result', title: `t${at}`, body: 'b' })
    const report = parseReport(JSON.stringify({
      summary: 's',
      inbox: Array.from({ length: 15 }, (_, at) => item(at)),
      notes: Array.from({ length: 30 }, (_, at) => `n${at}`),
    }))
    if ('error' in report) throw new Error(report.error)
    expect(report.inbox.length).toBe(10)
    expect(report.notes.length).toBe(20)
    expect(report.summary).toBe('s (5 more inbox items and 10 more notes were not kept)')
  })

  test('long text is clipped', async () => {
    const report = parseReport(JSON.stringify({
      summary: 'x'.repeat(1_000),
      inbox: [{ kind: 'result', title: 'y'.repeat(500), body: 'z'.repeat(10_000) }],
      notes: ['w'.repeat(2_000)],
    }))
    if ('error' in report) throw new Error(report.error)
    expect(report.summary.length).toBeLessThanOrEqual(300)
    expect(report.inbox[0]?.title.length).toBeLessThanOrEqual(200)
    expect(report.inbox[0]?.body.length).toBeLessThanOrEqual(4_000)
    expect(report.notes[0]?.length).toBeLessThanOrEqual(500)
    expect(report.inbox[0]?.body.endsWith('…')).toBe(true)
  })

  test('says why a malformed report is refused', async () => {
    expect(parseReport('no json here')).toEqual({ error: expect.stringContaining('no JSON') })
    expect(parseReport('{"summary":"x","inbox":[{"kind":"gossip","title":"t","body":"b"}]}')).toEqual({ error: expect.stringContaining('gossip') })
  })
})

describe('parseCommand', () => {
  test('bare opens the dot', async () => {
    expect(parseCommand('')).toEqual({ kind: 'open' })
  })

  test('assign with and without a schedule', async () => {
    expect(parseCommand('assign weekdays 9:00 | Check CI on main')).toEqual({
      kind: 'assign',
      text: 'Check CI on main',
      schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], minute: 540 },
    })
    expect(parseCommand('assign Keep the README current')).toEqual({ kind: 'assign', text: 'Keep the README current', schedule: null })
    expect(parseCommand('assign whenever | x')).toEqual({ kind: 'error', text: expect.stringContaining('whenever') })
  })

  test('rules', async () => {
    expect(parseCommand('rule handoff Bash(gh pr merge*)')).toEqual({ kind: 'rule', level: 'handoff', action: 'Bash(gh pr merge*)' })
    expect(parseCommand('rule ask before replying to users')).toEqual({ kind: 'rule', level: 'ask', action: 'before replying to users' })
    expect(parseCommand('rule sometimes x')).toEqual({ kind: 'error', text: expect.stringContaining('allow, when-asked, ask, handoff') })
  })

  test('numbered items', async () => {
    expect(parseCommand('run 2')).toEqual({ kind: 'run', index: 2 })
    expect(parseCommand('forget all')).toEqual({ kind: 'forget', index: 'all' })
    expect(parseCommand('pause x')).toEqual({ kind: 'error', text: expect.stringContaining('number') })
  })

  test('unknown words say what exists', async () => {
    expect(parseCommand('dance')).toEqual({ kind: 'error', text: expect.stringContaining('assign') })
  })
})

describe('parseCommand: check', () => {
  test('sets or clears a responsibility’s pre-check', async () => {
    expect(parseCommand('check 1 ~/.claude/dot/agent-mail-check.sh')).toEqual({ kind: 'check', index: 1, command: '~/.claude/dot/agent-mail-check.sh' })
    expect(parseCommand('check 2 test -s inbox.json && echo yes')).toEqual({ kind: 'check', index: 2, command: 'test -s inbox.json && echo yes' })
    expect(parseCommand('check 1 off')).toEqual({ kind: 'check', index: 1, command: null })
    expect(parseCommand('check 1')).toEqual(expect.objectContaining({ kind: 'error' }))
    expect(parseCommand('check one sh x.sh')).toEqual(expect.objectContaining({ kind: 'error' }))
  })
})

describe('decodeData', () => {
  test('nothing stored is a fresh dot', async () => {
    expect(decodeData(undefined)).toEqual(emptyData())
  })

  test('a stored value round-trips', async () => {
    const data = { ...emptyData(), notes: [{ id: 'n1', at: 1, text: 'prefers pnpm', source: 'you' }] }
    expect(decodeData(JSON.parse(JSON.stringify(data)))).toEqual(data)
  })

  test('a store written before the feed existed has no feed session; a malformed list throws', async () => {
    const { feedSessions: _none, ...old } = emptyData()

    expect(decodeData(JSON.parse(JSON.stringify(old)))).toEqual(emptyData())
    expect(decodeData({ ...old, feedSessions: ['s1'] }).feedSessions).toEqual(['s1'])
    expect(() => decodeData({ ...old, feedSessions: 's1' })).toThrow('feedSessions')
    expect(() => decodeData({ ...old, feedSessions: [1] })).toThrow('feedSessions')
  })

  test('a schedule out of range is malformed', async () => {
    const withSchedule = (schedule: unknown) => ({
      ...emptyData(),
      responsibilities: [{
        id: 'r', text: 't', schedule, cwd: '/', createdAt: 0, nextRunAt: null, lastRunAt: null, lastSummary: null, isPaused: false,
      }],
    })
    expect(() => decodeData(withSchedule({ kind: 'interval', minutes: 0 }))).toThrow('minutes')
    expect(() => decodeData(withSchedule({ kind: 'interval', minutes: 1.5 }))).toThrow('minutes')
    expect(() => decodeData(withSchedule({ kind: 'interval', minutes: 1e24 }))).toThrow('minutes')
    expect(() => decodeData(withSchedule({ kind: 'weekly', days: [1], minute: 1440 }))).toThrow('minute')
    expect(() => decodeData(withSchedule({ kind: 'weekly', days: [7], minute: 540 }))).toThrow('days')
    expect(() => decodeData(withSchedule({ kind: 'weekly', days: [], minute: 540 }))).toThrow('days')
    expect(() => decodeData(withSchedule({ kind: 'weekly', days: [1, 1], minute: 540 }))).toThrow('days')
    expect(decodeData(withSchedule({ kind: 'weekly', days: [1, 5], minute: 0 })).responsibilities[0]?.schedule).toEqual({ kind: 'weekly', days: [1, 5], minute: 0 })
  })

  test('a responsibility saved before pre-checks existed has none; a malformed one throws', async () => {
    const withCheck = (extra: Record<string, unknown>) => ({
      ...emptyData(),
      responsibilities: [{
        id: 'r', text: 't', schedule: null, cwd: '/', createdAt: 0, nextRunAt: null, lastRunAt: null, lastSummary: null, isPaused: false, ...extra,
      }],
    })
    expect(decodeData(withCheck({})).responsibilities[0]?.check).toBeNull()
    expect(decodeData(withCheck({ check: 'sh x.sh' })).responsibilities[0]?.check).toBe('sh x.sh')
    expect(() => decodeData(withCheck({ check: 5 }))).toThrow('check')
  })

  test('a malformed value throws instead of resetting quietly', async () => {
    expect(() => decodeData({ version: 9 })).toThrow('version')
    expect(() => decodeData({ ...emptyData(), notes: [{ id: 'n1' }] })).toThrow('notes[0]')
  })
})
