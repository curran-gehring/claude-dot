import type {
  DotActivity,
  DotData,
  DotIdentity,
  DotInboxItem,
  DotNote,
  DotResponsibility,
  DotRule,
  DotSchedule,
} from '../../types'
import { ACCESSORIES, COLORS, EYES, GLASSES, SHAPES } from './avatar'
import { isObject } from './json'

export function emptyData(): DotData {
  return {
    version: 1,
    rev: 0,
    lineage: [],
    dot: null,
    responsibilities: [],
    rules: [],
    notes: [],
    inbox: [],
    activity: [],
    settings: { isAsleep: false, isAutoReview: true, isBandShown: true },
    lastResearchAt: {},
    heartbeats: {},
  }
}

/** Thrown when the stored dot does not read as one; the caller keeps the raw value. */
export class DotDataError extends Error {}

/**
 * Reads what `$.store` holds into a DotData, or throws naming the first field
 * that is wrong. Nothing stored yet is a fresh, unnamed dot.
 */
export function decodeData(raw: unknown): DotData {
  if (raw === undefined || raw === null) return emptyData()
  const at = 'data'
  const value = obj(raw, at)
  if (value.version !== 1) throw new DotDataError(`${at}.version is ${JSON.stringify(value.version)}, expected 1`)

  const settings = obj(value.settings, `${at}.settings`)
  const lastResearchAt = timestamps(value.lastResearchAt, `${at}.lastResearchAt`)
  const heartbeats = timestamps(value.heartbeats, `${at}.heartbeats`)

  return {
    version: 1,
    rev: num(value.rev, `${at}.rev`),
    lineage: list(value.lineage, `${at}.lineage`, str),
    dot: value.dot === null ? null : identity(value.dot, `${at}.dot`),
    responsibilities: list(value.responsibilities, `${at}.responsibilities`, responsibility),
    rules: list(value.rules, `${at}.rules`, rule),
    notes: list(value.notes, `${at}.notes`, note),
    inbox: list(value.inbox, `${at}.inbox`, inboxItem),
    activity: list(value.activity, `${at}.activity`, activity),
    settings: {
      isAsleep: bool(settings.isAsleep, `${at}.settings.isAsleep`),
      isAutoReview: bool(settings.isAutoReview, `${at}.settings.isAutoReview`),
      isBandShown: bool(settings.isBandShown, `${at}.settings.isBandShown`),
    },
    lastResearchAt,
    heartbeats,
  }
}

function identity(raw: unknown, at: string): DotIdentity {
  const value = obj(raw, at)
  const look = obj(value.look, `${at}.look`)

  return {
    name: str(value.name, `${at}.name`),
    createdAt: num(value.createdAt, `${at}.createdAt`),
    look: {
      shape: oneOf(look.shape, SHAPES, `${at}.look.shape`),
      eyes: oneOf(look.eyes, EYES, `${at}.look.eyes`),
      glasses: oneOf(look.glasses, GLASSES, `${at}.look.glasses`),
      accessory: oneOf(look.accessory, ACCESSORIES, `${at}.look.accessory`),
      color: oneOf(look.color, COLORS, `${at}.look.color`),
    },
  }
}

function schedule(raw: unknown, at: string): DotSchedule | null {
  if (raw === null) return null
  const value = obj(raw, at)
  if (value.kind === 'interval') return { kind: 'interval', minutes: num(value.minutes, `${at}.minutes`) }
  if (value.kind === 'weekly') {
    return {
      kind: 'weekly',
      days: list(value.days, `${at}.days`, num),
      minute: num(value.minute, `${at}.minute`),
    }
  }
  throw new DotDataError(`${at}.kind is ${JSON.stringify(value.kind)}`)
}

function responsibility(raw: unknown, at: string): DotResponsibility {
  const value = obj(raw, at)

  return {
    id: str(value.id, `${at}.id`),
    text: str(value.text, `${at}.text`),
    schedule: schedule(value.schedule, `${at}.schedule`),
    cwd: str(value.cwd, `${at}.cwd`),
    createdAt: num(value.createdAt, `${at}.createdAt`),
    nextRunAt: nullable(value.nextRunAt, `${at}.nextRunAt`, num),
    lastRunAt: nullable(value.lastRunAt, `${at}.lastRunAt`, num),
    lastSummary: nullable(value.lastSummary, `${at}.lastSummary`, str),
    isPaused: bool(value.isPaused, `${at}.isPaused`),
  }
}

function rule(raw: unknown, at: string): DotRule {
  const value = obj(raw, at)

  return {
    id: str(value.id, `${at}.id`),
    level: oneOf(value.level, ['allow', 'when-asked', 'ask', 'handoff'] as const, `${at}.level`),
    action: str(value.action, `${at}.action`),
  }
}

function note(raw: unknown, at: string): DotNote {
  const value = obj(raw, at)

  return {
    id: str(value.id, `${at}.id`),
    at: num(value.at, `${at}.at`),
    text: str(value.text, `${at}.text`),
    source: oneOf(value.source, ['you', 'research', 'work'] as const, `${at}.source`),
  }
}

function inboxItem(raw: unknown, at: string): DotInboxItem {
  const value = obj(raw, at)

  return {
    id: str(value.id, `${at}.id`),
    at: num(value.at, `${at}.at`),
    kind: oneOf(value.kind, ['question', 'suggestion', 'result', 'handoff', 'blocked'] as const, `${at}.kind`),
    title: str(value.title, `${at}.title`),
    body: str(value.body, `${at}.body`),
    isDone: bool(value.isDone, `${at}.isDone`),
  }
}

function activity(raw: unknown, at: string): DotActivity {
  const value = obj(raw, at)

  return {
    id: str(value.id, `${at}.id`),
    kind: oneOf(value.kind, ['work', 'research', 'delegate'] as const, `${at}.kind`),
    label: str(value.label, `${at}.label`),
    cwd: str(value.cwd, `${at}.cwd`),
    responsibilityId: nullable(value.responsibilityId, `${at}.responsibilityId`, str),
    agentId: nullable(value.agentId, `${at}.agentId`, str),
    sessionId: str(value.sessionId, `${at}.sessionId`),
    status: oneOf(value.status, ['running', 'done', 'failed'] as const, `${at}.status`),
    startedAt: num(value.startedAt, `${at}.startedAt`),
    endedAt: nullable(value.endedAt, `${at}.endedAt`, num),
    summary: nullable(value.summary, `${at}.summary`, str),
  }
}

function timestamps(raw: unknown, at: string): Record<string, number> {
  const value = obj(raw, at)
  for (const [key, when] of Object.entries(value)) num(when, `${at}[${key}]`)
  return value as Record<string, number>
}

function obj(raw: unknown, at: string): Record<string, unknown> {
  if (!isObject(raw)) throw new DotDataError(`${at} is not an object`)
  return raw
}

function str(raw: unknown, at: string): string {
  if (typeof raw !== 'string') throw new DotDataError(`${at} is not a string`)
  return raw
}

function num(raw: unknown, at: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new DotDataError(`${at} is not a number`)
  return raw
}

function bool(raw: unknown, at: string): boolean {
  if (typeof raw !== 'boolean') throw new DotDataError(`${at} is not true or false`)
  return raw
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], at: string): T {
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    throw new DotDataError(`${at} is ${JSON.stringify(raw)}, not one of ${allowed.join(', ')}`)
  }
  return raw as T
}

function nullable<T>(raw: unknown, at: string, read: (raw: unknown, at: string) => T): T | null {
  return raw === null ? null : read(raw, at)
}

function list<T>(raw: unknown, at: string, read: (raw: unknown, at: string) => T): T[] {
  if (!Array.isArray(raw)) throw new DotDataError(`${at} is not a list`)
  return raw.map((item, index) => read(item, `${at}[${index}]`))
}
