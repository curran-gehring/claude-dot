import type { DotData, DotInboxItem } from '../types'
import { face, moodOf, needsYou } from './core/avatar'
import { ago, formatWhen } from './core/ops'
import { describeSchedule } from './core/schedule'
import type { Offset } from './core/schedule'

export const KIND_MARK: Record<DotInboxItem['kind'], string> = {
  question: '?', suggestion: '+', result: '·', handoff: '→', blocked: '×',
}

export function openInbox(data: DotData): DotInboxItem[] {
  return data.inbox.filter(item => !item.isDone)
}

export function responsibilitiesText(data: DotData, now: number, offset: Offset): string {
  if (data.responsibilities.length === 0) return 'It has no responsibilities yet. /dot assign <when> | <job> gives it one.'

  return data.responsibilities.map((one, at) => {
    const when = one.isPaused
      ? 'paused'
      : one.nextRunAt === null ? describeSchedule(null) : `${describeSchedule(one.schedule)}, next ${formatWhen(one.nextRunAt, now, offset)}`
    const last = one.lastSummary ? `\n   last: ${one.lastSummary}` : ''
    return `${at + 1}. ${one.text}  (${when})${last}`
  }).join('\n')
}

export function inboxText(data: DotData, now: number): string {
  const open = openInbox(data)
  if (open.length === 0) return 'Nothing for you right now.'

  return open.map((item, at) => `${at + 1}. ${KIND_MARK[item.kind]} ${item.title} (${ago(item.at, now)})\n   ${item.body.replace(/\n/g, '\n   ')}`).join('\n')
}

export function rulesText(data: DotData): string {
  if (data.rules.length === 0) return 'No rules yet. /dot rule <allow|when-asked|ask|handoff> <action> adds one.'
  return data.rules.map((rule, at) => `${at + 1}. [${rule.level}] ${rule.action}`).join('\n')
}

export function notesText(data: DotData, now: number): string {
  if (data.notes.length === 0) return 'Its notebook is empty.'
  return data.notes.map((note, at) => `${at + 1}. ${note.text}  (${note.source}, ${ago(note.at, now)})`).join('\n')
}

export function statusText(data: DotData, now: number, offset: Offset): string {
  if (data.dot === null) return 'No dot yet: /dot setup.'
  const running = data.activity.filter(one => one.status === 'running')
  const recent = data.activity.filter(one => one.status !== 'running').slice(-5).reverse()

  return [
    `${face(data.dot.look, moodOf(data))} ${data.dot.name}${data.settings.isAsleep ? ' (asleep)' : ''}  ·  Auto-review ${data.settings.isAutoReview ? 'on' : 'off'}`,
    '',
    `Needs you (${needsYou(data).length}) · inbox (${openInbox(data).length}):`,
    inboxText(data, now),
    '',
    'Working on:',
    running.length === 0 ? 'nothing' : running.map(one => `● ${one.label} (started ${ago(one.startedAt, now)})`).join('\n'),
    '',
    'Responsibilities:',
    responsibilitiesText(data, now, offset),
    '',
    'Recently:',
    recent.length === 0 ? 'nothing yet' : recent.map(one => `${one.status === 'done' ? '✓' : '✗'} ${one.label}: ${one.summary ?? ''} (${ago(one.endedAt ?? one.startedAt, now)})`).join('\n'),
  ].join('\n')
}
