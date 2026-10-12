import type { DotInboxKind } from '../../types'
import { isObject, lastJsonObject } from './json'

export type ReportItem = { kind: DotInboxKind; title: string; body: string }
export type Report = { summary: string; needsYou: boolean; inbox: ReportItem[]; notes: string[] }

const KINDS: readonly DotInboxKind[] = ['question', 'suggestion', 'result', 'handoff', 'blocked']

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

  return { summary: summary.trim(), needsYou, inbox: items, notes: notes.filter(note => note.trim() !== '') }
}

export const REPORT_FORMAT = [
  'End your final answer with one fenced ```json block, the last thing you write, shaped:',
  '{"summary": "<one line: what you found or did>",',
  ' "needsYou": <true only if the person must look or decide soon>,',
  ' "inbox": [{"kind": "question|suggestion|result|handoff|blocked", "title": "<short>", "body": "<what and why, with links or paths>"}],',
  ' "notes": ["<a durable fact worth remembering next time: a preference, a decision, where something lives>"]}',
  'Leave inbox empty when there is nothing worth the person\'s attention. Notes are facts, not a log of what you did.',
].join('\n')
