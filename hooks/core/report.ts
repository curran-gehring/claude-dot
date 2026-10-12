import type { DotInboxKind } from '../../types'
import { isObject, lastJsonObject } from './json'

export type ReportItem = { kind: DotInboxKind; title: string; body: string }
export type Report = { summary: string; needsYou: boolean; inbox: ReportItem[]; notes: string[] }

const KINDS: readonly DotInboxKind[] = ['question', 'suggestion', 'result', 'handoff', 'blocked']
/** What one report may put in the shared store: the rest is dropped and said in the summary. */
export const LIMITS = { inbox: 10, notes: 20, summary: 300, title: 200, body: 4_000, note: 500 } as const

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** What a worker or researcher reported at the end of its answer, or why it is refused. */
export function parseReport(answer: string): Report | { error: string } {
  const value = lastJsonObject(answer)
  if (!isObject(value)) return { error: 'the agent ended with no JSON report' }

  const { summary, needsYou = false, inbox = [], notes = [] } = value
  if (typeof summary !== 'string' || summary.trim() === '') return { error: 'the report has no summary' }
  if (typeof needsYou !== 'boolean') return { error: 'needsYou is not true or false' }
  if (!Array.isArray(inbox)) return { error: 'inbox is not a list' }
  if (!Array.isArray(notes) || !notes.every(note => typeof note === 'string')) return { error: 'notes is not a list of strings' }

  const items: ReportItem[] = []
  for (const [at, item] of inbox.entries()) {
    if (!isObject(item)) return { error: `inbox[${at}] is not an object` }
    const { kind, title, body } = item
    if (typeof kind !== 'string' || !KINDS.includes(kind as DotInboxKind)) {
      return { error: `inbox[${at}].kind "${String(kind)}" is not one of ${KINDS.join(', ')}` }
    }
    if (typeof title !== 'string' || typeof body !== 'string') return { error: `inbox[${at}] needs a title and a body` }
    items.push({ kind: kind as DotInboxKind, title, body })
  }

  const kept = notes.filter(note => note.trim() !== '')
  const dropped = [
    items.length > LIMITS.inbox ? `${items.length - LIMITS.inbox} more inbox items` : '',
    kept.length > LIMITS.notes ? `${kept.length - LIMITS.notes} more notes` : '',
  ].filter(Boolean)
  const said = dropped.length === 0 ? summary.trim() : `${summary.trim()} (${dropped.join(' and ')} were not kept)`

  return {
    summary: clip(said, LIMITS.summary),
    needsYou,
    inbox: items.slice(0, LIMITS.inbox).map(item => ({ kind: item.kind, title: clip(item.title, LIMITS.title), body: clip(item.body, LIMITS.body) })),
    notes: kept.slice(0, LIMITS.notes).map(note => clip(note, LIMITS.note)),
  }
}

export const REPORT_FORMAT = [
  'End your final answer with one fenced ```json block, the last thing you write, shaped:',
  '{"summary": "<one line: what you found or did>",',
  ' "needsYou": <true only if the person must look or decide soon>,',
  ' "inbox": [{"kind": "question|suggestion|result|handoff|blocked", "title": "<short>", "body": "<what and why, with links or paths>"}],',
  ' "notes": ["<a durable fact worth remembering next time: a preference, a decision, where something lives>"]}',
  'Leave inbox empty when there is nothing worth the person\'s attention. Notes are facts, not a log of what you did.',
  `At most ${LIMITS.inbox} inbox items and ${LIMITS.notes} notes are kept; keep a body under ${LIMITS.body} characters and a note under ${LIMITS.note}.`,
].join('\n')
