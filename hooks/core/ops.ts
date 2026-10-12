import type { DotActivity, DotActivityKind, DotData, DotInboxItem, DotNote, DotResponsibility, DotSchedule } from '../../types'
import type { Report, ReportItem } from './report'
import { clockOf, nextRunAt } from './schedule'
import type { Offset } from './schedule'

const MIN = 60_000
const DAY = 24 * 60 * MIN
/** A session that has not checked in for this long is gone, and so is the work it was running. */
const HEARTBEAT_STALE = 5 * MIN
/** No background run takes this long; one that has is failed so its job can run again. */
const MAX_RUN = 3 * 60 * MIN
const MAX_NOTES = 200
const MAX_DONE_INBOX = 50
/** Open items kept: past this the oldest give way, so no run can grow the store without bound. */
const MAX_OPEN_INBOX = 100
const MAX_FINISHED_ACTIVITY = 50
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Clock = { now: number; offsetOf: Offset }
type Ids = { now: number; newId: () => string }

export function addResponsibility(
  data: DotData,
  job: { text: string; schedule: DotSchedule | null; cwd: string },
  at: Clock & { id: string },
): DotData {
  const responsibility: DotResponsibility = {
    id: at.id,
    text: job.text,
    schedule: job.schedule,
    cwd: job.cwd,
    createdAt: at.now,
    nextRunAt: job.schedule === null ? null : nextRunAt(job.schedule, at.now, at.offsetOf),
    lastRunAt: null,
    lastSummary: null,
    isPaused: false,
  }

  return { ...data, responsibilities: [...data.responsibilities, responsibility] }
}

export function isRunning(data: DotData, test: (one: DotActivity) => boolean): boolean {
  return data.activity.some(one => one.status === 'running' && test(one))
}

export function dueResponsibilities(data: DotData, now: number): DotResponsibility[] {
  return data.responsibilities.filter(one =>
    !one.isPaused
    && one.nextRunAt !== null
    && one.nextRunAt <= now
    && !isRunning(data, run => run.responsibilityId === one.id))
}

export type Job = { kind: DotActivityKind; responsibilityId: string | null; label: string; cwd: string }

/**
 * Starts an activity for a job, or null when the same job is already running
 * (a responsibility, or a research pass on the same project), so two open
 * sessions never run it twice.
 */
export function claimWork(
  data: DotData,
  job: Job,
  at: Clock & { id: string; sessionId: string },
): { data: DotData; activity: DotActivity } | null {
  const isTaken = job.kind === 'work'
    ? isRunning(data, one => one.responsibilityId === job.responsibilityId)
    : job.kind === 'research' && isRunning(data, one => one.kind === 'research' && one.cwd === job.cwd)
  if (isTaken) return null

  const activity: DotActivity = {
    id: at.id,
    kind: job.kind,
    label: job.label,
    cwd: job.cwd,
    responsibilityId: job.responsibilityId,
    agentId: null,
    sessionId: at.sessionId,
    status: 'running',
    startedAt: at.now,
    endedAt: null,
    summary: null,
  }
  const responsibilities = data.responsibilities.map(one =>
    one.id !== job.responsibilityId
      ? one
      : { ...one, lastRunAt: at.now, nextRunAt: one.schedule === null ? null : nextRunAt(one.schedule, at.now, at.offsetOf) })
  const lastResearchAt = job.kind === 'research' ? { ...data.lastResearchAt, [job.cwd]: at.now } : data.lastResearchAt

  return { data: trimActivity({ ...data, responsibilities, lastResearchAt, activity: [...data.activity, activity] }), activity }
}

/**
 * Records what a worker reported when its agent finished, or why its report
 * was refused; null when the agent is not one of the dot's running jobs.
 */
export function finishWork(
  data: DotData,
  agentId: string,
  outcome: Report | { error: string },
  at: Ids,
): { data: DotData; activity: DotActivity } | null {
  const running = data.activity.find(one => one.status === 'running' && one.agentId === agentId)
  if (running === undefined) return null

  const isFailed = 'error' in outcome
  const summary = isFailed ? `could not report: ${outcome.error}` : outcome.summary
  const activity: DotActivity = { ...running, status: isFailed ? 'failed' : 'done', endedAt: at.now, summary }
  let next: DotData = {
    ...data,
    activity: data.activity.map(one => (one.id === running.id ? activity : one)),
    responsibilities: data.responsibilities.map(one => (one.id === running.responsibilityId ? { ...one, lastSummary: summary } : one)),
  }
  if (isFailed) {
    next = addInbox(next, [{ kind: 'result', title: `${running.label}: no report`, body: `The run finished but ${outcome.error}.` }], at)
  } else {
    next = addInbox(next, outcome.inbox, at)
    next = addNotes(next, outcome.notes, running.kind === 'research' ? 'research' : 'work', at)
  }

  return { data: trimActivity(next), activity }
}

export function failWork(data: DotData, activityId: string, reason: string, now: number): DotData {
  return {
    ...data,
    activity: data.activity.map(one =>
      one.id === activityId && one.status === 'running' ? { ...one, status: 'failed', endedAt: now, summary: reason } : one),
  }
}

export function reapStale(data: DotData, now: number): DotData {
  const isAlive = (sessionId: string) => (data.heartbeats[sessionId] ?? 0) >= now - HEARTBEAT_STALE
  const heartbeats = Object.fromEntries(Object.entries(data.heartbeats).filter(([, at]) => at >= now - DAY))

  return {
    ...data,
    heartbeats,
    activity: data.activity.map(one => {
      if (one.status !== 'running') return one
      if (!isAlive(one.sessionId)) return { ...one, status: 'failed', endedAt: now, summary: 'interrupted: its session closed before it finished' }
      if (now - one.startedAt > MAX_RUN) return { ...one, status: 'failed', endedAt: now, summary: 'gave up: no report after 3h' }
      return one
    }),
  }
}

export function addInbox(data: DotData, items: readonly ReportItem[], at: Ids): DotData {
  const added: DotInboxItem[] = items.map(item => ({ ...item, id: at.newId(), at: at.now, isDone: false }))
  const inbox = [...data.inbox, ...added]
  const done = inbox.filter(item => item.isDone)
  const open = inbox.filter(item => !item.isDone)
  const dropped = new Set([
    ...done.slice(0, Math.max(0, done.length - MAX_DONE_INBOX)),
    ...open.slice(0, Math.max(0, open.length - MAX_OPEN_INBOX)),
  ].map(item => item.id))

  return { ...data, inbox: inbox.filter(item => !dropped.has(item.id)) }
}

export function addNotes(data: DotData, texts: readonly string[], source: DotNote['source'], at: Ids): DotData {
  const known = new Set(data.notes.map(note => key(note.text)))
  const added: DotNote[] = []
  for (const text of texts) {
    const said = text.trim()
    if (said === '' || known.has(key(said))) continue
    known.add(key(said))
    added.push({ id: at.newId(), at: at.now, text: said, source })
  }

  return { ...data, notes: [...data.notes, ...added].slice(-MAX_NOTES) }
}

function key(text: string): string {
  return text.trim().toLowerCase()
}

function trimActivity(data: DotData): DotData {
  const finished = data.activity.filter(one => one.status !== 'running')
  const dropped = new Set(finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_ACTIVITY)).map(one => one.id))

  return dropped.size === 0 ? data : { ...data, activity: data.activity.filter(one => !dropped.has(one.id)) }
}

/** `09:00` today, `Tue 09:00` another day, in the person's local time. */
export function formatWhen(at: number, now: number, offsetOf: Offset): string {
  const local = at + offsetOf(at) * MIN
  const today = Math.floor((now + offsetOf(now) * MIN) / DAY)
  const day = Math.floor(local / DAY)
  const clock = clockOf(Math.floor((local % DAY) / MIN))

  return day === today ? clock : `${DAY_NAMES[new Date(day * DAY).getUTCDay()]} ${clock}`
}

export function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / MIN)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`

  return `${Math.floor(minutes / (24 * 60))}d ago`
}
