import { describe, expect, test } from 'claude-code/testing'

import { emptyData } from '../hooks/core/data'
import { moodOf } from '../hooks/core/avatar'
import { abandonClaim, addInbox, beat, hasLiveFeed, leave, addNotes, addResponsibility, ago, claimWork, dueResponsibilities, selfPacedDue, finishWork, formatWhen, reapStale, skipRun } from '../hooks/core/ops'

const MIN = 60_000
const UTC = () => 0
const NOW = Date.UTC(2026, 9, 12, 8) // Monday 08:00 UTC
const ids = (() => {
  let n = 0
  return () => `id${++n}`
})()

function withJob(schedule: Parameters<typeof addResponsibility>[1]['schedule'] = { kind: 'interval', minutes: 60 }) {
  return addResponsibility(emptyData(), { text: 'Check CI on main', schedule, cwd: 'C:/Dev/app' }, { now: NOW, offsetOf: UTC, id: 'r1' })
}

describe('responsibilities', () => {
  test('a scheduled one gets its first run time; an unscheduled one none', async () => {
    expect(withJob().responsibilities[0]?.nextRunAt).toBe(NOW + 60 * MIN)
    expect(withJob(null).responsibilities[0]?.nextRunAt).toBeNull()
  })

  test('due means scheduled, not paused, not running, and its time has come', async () => {
    const data = withJob()
    expect(dueResponsibilities(data, NOW)).toEqual([])
    expect(dueResponsibilities(data, NOW + 60 * MIN).map(r => r.id)).toEqual(['r1'])
    const claimed = claimWork(data, { kind: 'work', responsibilityId: 'r1', label: 'Check CI on main', cwd: 'C:/Dev/app' }, { now: NOW + 60 * MIN, offsetOf: UTC, id: 'a1', sessionId: 's1' })
    expect(claimed && dueResponsibilities(claimed.data, NOW + 61 * MIN)).toEqual([])
  })
})

test('a run its pre-check turned down moves on without running', async () => {
  const at = NOW + 60 * MIN
  const scheduled = skipRun(withJob(), 'r1', at, UTC)
  expect(scheduled.responsibilities[0]).toEqual(expect.objectContaining({ nextRunAt: at + 60 * MIN, lastSummary: null }))
  expect(scheduled.activity).toEqual([])
  expect(dueResponsibilities(scheduled, at + MIN)).toEqual([])

  const ownPace = skipRun(withJob(null), 'r1', at, UTC)
  expect(ownPace.responsibilities[0]?.lastRunAt).toBe(at)
  expect(selfPacedDue(ownPace, at + MIN, 120 * MIN)).toEqual([])
})

describe('claimWork', () => {
  test('starts an activity and moves the schedule on', async () => {
    const claimed = claimWork(withJob(), { kind: 'work', responsibilityId: 'r1', label: 'Check CI', cwd: 'C:/Dev/app' }, { now: NOW + 60 * MIN, offsetOf: UTC, id: 'a1', sessionId: 's1' })
    expect(claimed?.activity).toEqual(expect.objectContaining({ id: 'a1', status: 'running', sessionId: 's1', agentId: null }))
    expect(claimed?.data.responsibilities[0]?.nextRunAt).toBe(NOW + 120 * MIN)
    expect(claimed?.data.responsibilities[0]?.lastRunAt).toBe(NOW + 60 * MIN)
  })

  test('refuses a second run of the same responsibility', async () => {
    const job = { kind: 'work', responsibilityId: 'r1', label: 'Check CI', cwd: 'C:/Dev/app' } as const
    const first = claimWork(withJob(), job, { now: NOW, offsetOf: UTC, id: 'a1', sessionId: 's1' })
    expect(first && claimWork(first.data, job, { now: NOW, offsetOf: UTC, id: 'a2', sessionId: 's2' })).toBeNull()
  })

  test('refuses a second research pass on the same project', async () => {
    const job = { kind: 'research', responsibilityId: null, label: 'research', cwd: 'C:/Dev/app' } as const
    const first = claimWork(emptyData(), job, { now: NOW, offsetOf: UTC, id: 'a1', sessionId: 's1' })
    expect(first && claimWork(first.data, job, { now: NOW, offsetOf: UTC, id: 'a2', sessionId: 's1' })).toBeNull()
    expect(first?.data.lastResearchAt['C:/Dev/app']).toBe(NOW)
  })
})

describe('finishWork', () => {
  const started = () => {
    const claimed = claimWork(withJob(), { kind: 'work', responsibilityId: 'r1', label: 'Check CI', cwd: 'C:/Dev/app' }, { now: NOW, offsetOf: UTC, id: 'a1', sessionId: 's1' })
    if (claimed === null) throw new Error('not claimed')
    return { ...claimed.data, activity: claimed.data.activity.map(a => ({ ...a, agentId: 'agent-7' })) }
  }

  test('a report lands in the activity, the responsibility, the inbox and the notes', async () => {
    const report = { summary: 'main is red', needsYou: true, inbox: [{ kind: 'question' as const, title: 'Revert #41?', body: 'It broke login.' }], notes: ['CI is GitHub Actions'] }
    const done = finishWork(started(), 'agent-7', report, { now: NOW + 5 * MIN, newId: ids })
    expect(done?.activity).toEqual(expect.objectContaining({ status: 'done', summary: 'main is red', endedAt: NOW + 5 * MIN }))
    expect(done?.data.responsibilities[0]?.lastSummary).toBe('main is red')
    expect(done?.data.inbox).toEqual([expect.objectContaining({ kind: 'question', title: 'Revert #41?', isDone: false })])
    expect(done?.data.notes).toEqual([expect.objectContaining({ text: 'CI is GitHub Actions', source: 'work' })])
  })

  test('a refused report fails the activity and says why in the inbox', async () => {
    const done = finishWork(started(), 'agent-7', { error: 'the agent ended with no JSON report' }, { now: NOW, newId: ids })
    expect(done?.activity.status).toBe('failed')
    expect(done?.data.inbox[0]).toEqual(expect.objectContaining({ kind: 'result', body: expect.stringContaining('no JSON report') }))
  })

  test('an agent that is not the dot’s is left alone', async () => {
    expect(finishWork(started(), 'someone-else', { error: 'x' }, { now: NOW, newId: ids })).toBeNull()
  })
})

test('reapStale fails work whose session stopped checking in', async () => {
  const claimed = claimWork(withJob(), { kind: 'work', responsibilityId: 'r1', label: 'Check CI', cwd: 'C:/Dev/app' }, { now: NOW, offsetOf: UTC, id: 'a1', sessionId: 'gone' })
  if (claimed === null) throw new Error('not claimed')
  const alive = { ...claimed.data, heartbeats: { gone: NOW } }
  expect(reapStale(alive, NOW + 2 * MIN).activity[0]?.status).toBe('running')
  const reaped = reapStale(alive, NOW + 10 * MIN)
  expect(reaped.activity[0]).toEqual(expect.objectContaining({ status: 'failed', summary: expect.stringContaining('session closed') }))
  expect(reaped.heartbeats).toEqual({ gone: NOW })
  expect(reapStale(alive, NOW + 2 * 24 * 60 * MIN).heartbeats).toEqual({})
})

test('reapStale fails work that has run too long, even in a live session', async () => {
  const claimed = claimWork(withJob(), { kind: 'work', responsibilityId: 'r1', label: 'Check CI', cwd: 'C:/Dev/app' }, { now: NOW, offsetOf: UTC, id: 'a1', sessionId: 's1' })
  if (claimed === null) throw new Error('not claimed')
  const later = NOW + 4 * 60 * MIN
  const reaped = reapStale({ ...claimed.data, heartbeats: { s1: later } }, later)
  expect(reaped.activity[0]).toEqual(expect.objectContaining({ status: 'failed', summary: expect.stringContaining('3h') }))
  expect(dueResponsibilities(reaped, later).map(r => r.id)).toEqual(['r1'])
})

test('addNotes skips what it already knows', async () => {
  const once = addNotes(emptyData(), ['Prefers pnpm'], 'you', { now: NOW, newId: ids })
  expect(addNotes(once, ['prefers pnpm ', 'Deploys on Render'], 'work', { now: NOW, newId: ids }).notes.map(n => n.text)).toEqual(['Prefers pnpm', 'Deploys on Render'])
})

test('formatWhen and ago read like a person would say them', async () => {
  expect(formatWhen(NOW + 60 * MIN, NOW, UTC)).toBe('09:00')
  expect(formatWhen(NOW + 25 * 60 * MIN, NOW, UTC)).toBe('Tue 09:00')
  expect(ago(NOW - 30_000, NOW)).toBe('just now')
  expect(ago(NOW - 5 * MIN, NOW)).toBe('5m ago')
  expect(ago(NOW - 3 * 60 * MIN, NOW)).toBe('3h ago')
  expect(ago(NOW - 2 * 24 * 60 * MIN, NOW)).toBe('2d ago')
})

test('the open inbox keeps the newest 100', async () => {
  const items = Array.from({ length: 130 }, (_, at) => ({ kind: 'result' as const, title: `t${at}`, body: 'b' }))
  const data = addInbox(emptyData(), items, { now: NOW, newId: ids })
  expect(data.inbox.length).toBe(100)
  expect(data.inbox[0]?.title).toBe('t30')
})

test('a report that needs the person keeps saying so after it is saved', async () => {
  const claimed = claimWork(withJob(), { kind: 'work', responsibilityId: 'r1', label: 'Check CI', cwd: 'C:/Dev/app' }, { now: NOW, offsetOf: UTC, id: 'a1', sessionId: 's1' })
  if (claimed === null) throw new Error('not claimed')
  const started = { ...claimed.data, activity: claimed.data.activity.map(a => ({ ...a, agentId: 'ag' })) }
  const withItem = finishWork(started, 'ag', { summary: 'deploy failed', needsYou: true, inbox: [{ kind: 'result', title: 'Deploy failed', body: 'b' }], notes: [] }, { now: NOW, newId: ids })
  expect(withItem?.data.inbox[0]?.isUrgent).toBe(true)
  expect(withItem && moodOf(withItem.data)).toBe('needs-you')
  const bare = finishWork(started, 'ag', { summary: 'deploy failed', needsYou: true, inbox: [], notes: [] }, { now: NOW, newId: ids })
  expect(bare?.data.inbox).toEqual([expect.objectContaining({ kind: 'result', title: 'Check CI: deploy failed', isUrgent: true })])
})

test('an unscheduled responsibility runs on the dot’s own pace', async () => {
  const data = withJob(null)
  const every = 120 * MIN
  expect(selfPacedDue(data, NOW, every).map(r => r.id)).toEqual(['r1'])
  const claimed = claimWork(data, { kind: 'work', responsibilityId: 'r1', label: 'Check CI', cwd: 'C:/Dev/app' }, { now: NOW, offsetOf: UTC, id: 'a1', sessionId: 's1' })
  if (claimed === null) throw new Error('not claimed')
  expect(selfPacedDue(claimed.data, NOW + MIN, every)).toEqual([])
  const done = { ...claimed.data, activity: claimed.data.activity.map(a => ({ ...a, status: 'done' as const })) }
  expect(selfPacedDue(done, NOW + 60 * MIN, every)).toEqual([])
  expect(selfPacedDue(done, NOW + 121 * MIN, every).map(r => r.id)).toEqual(['r1'])
  expect(selfPacedDue({ ...done, responsibilities: done.responsibilities.map(r => ({ ...r, isPaused: true })) }, NOW + 121 * MIN, every)).toEqual([])
  expect(selfPacedDue(withJob(), NOW, every)).toEqual([])
})

test('a claim whose agent never started is rolled back', async () => {
  const at = { now: NOW + 60 * MIN, offsetOf: UTC, id: 'a1', sessionId: 's1' }
  const work = claimWork(withJob(), { kind: 'work', responsibilityId: 'r1', label: 'Check CI', cwd: 'C:/Dev/app' }, at)
  if (work === null) throw new Error('not claimed')
  const rolled = abandonClaim(work.data, work.activity.id, work.previous, 'could not start', at.now)
  expect(rolled.responsibilities[0]).toEqual(expect.objectContaining({ nextRunAt: NOW + 60 * MIN, lastRunAt: null }))
  expect(rolled.activity[0]).toEqual(expect.objectContaining({ status: 'failed', summary: 'could not start' }))

  const research = claimWork(emptyData(), { kind: 'research', responsibilityId: null, label: 'r', cwd: 'C:/Dev/app' }, at)
  if (research === null) throw new Error('not claimed')
  expect(abandonClaim(research.data, research.activity.id, research.previous, 'x', at.now).lastResearchAt).toEqual({})
})

test('a rollback leaves alone what changed after its claim', async () => {
  const at = { now: NOW + 60 * MIN, offsetOf: UTC, id: 'a1', sessionId: 's1' }
  const work = claimWork(withJob(), { kind: 'work', responsibilityId: 'r1', label: 'Check CI', cwd: 'C:/Dev/app' }, at)
  if (work === null) throw new Error('not claimed')
  // Another session reaped this run and started a new one later.
  const reaped = reapStale({ ...work.data, heartbeats: {} }, at.now + 10 * MIN)
  const rerun = claimWork(reaped, { kind: 'work', responsibilityId: 'r1', label: 'Check CI', cwd: 'C:/Dev/app' }, { ...at, now: at.now + 10 * MIN, id: 'a2', sessionId: 's2' })
  if (rerun === null) throw new Error('not claimed')
  const rolled = abandonClaim(rerun.data, 'a1', work.previous, 'could not start', at.now + 11 * MIN)
  expect(rolled.responsibilities[0]).toEqual(expect.objectContaining({ lastRunAt: at.now + 10 * MIN, nextRunAt: at.now + 70 * MIN }))
  expect(rolled.activity.find(a => a.id === 'a2')?.status).toBe('running')
})

describe('the feed session', () => {
  test('a beat records the session as alive, and as the feed only when it is one', async () => {
    const feed = beat(emptyData(), 'feed', NOW, true)
    const both = beat(feed, 'other', NOW, false)

    expect(both.heartbeats).toEqual({ feed: NOW, other: NOW })
    expect(both.feedSessions).toEqual(['feed'])
    expect(beat(both, 'feed', NOW + MIN, true).feedSessions).toEqual(['feed'])
    expect(beat(both, 'feed', NOW + MIN, false).feedSessions).toEqual([])
  })

  test('another session’s fresh feed heartbeat is a live feed; mine, a stale one or none is not', async () => {
    const data = beat(beat(emptyData(), 'feed', NOW, true), 'other', NOW, false)

    expect(hasLiveFeed(data, NOW + 2 * MIN, 'other')).toBe(true)
    expect(hasLiveFeed(data, NOW + 2 * MIN, 'feed')).toBe(false)
    expect(hasLiveFeed(data, NOW + 10 * MIN, 'other')).toBe(false)
    expect(hasLiveFeed(beat(emptyData(), 'other', NOW, false), NOW, 'other')).toBe(false)
  })

  test('a feed that left, or went a day without checking in, is forgotten', async () => {
    const data = beat(beat(emptyData(), 'feed', NOW, true), 'other', NOW, false)

    expect(leave(data, 'feed')).toEqual(expect.objectContaining({ heartbeats: { other: NOW }, feedSessions: [] }))
    expect(reapStale(data, NOW + 2 * 24 * 60 * MIN).feedSessions).toEqual([])
    expect(reapStale(data, NOW + MIN).feedSessions).toEqual(['feed'])
  })
})
