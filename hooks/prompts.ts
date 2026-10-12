import type { DotData, DotResponsibility } from '../types'
import { REPORT_FORMAT } from './core/report'
import { describeSchedule } from './core/schedule'

export const WORKER_SYSTEM = [
  'You are a dot: an always-on companion that works in the background of Claude Code for one person, keeping their standing responsibilities true while they do other things.',
  '',
  'How you work:',
  '- Each run you get one responsibility or one delegated task, what you learned before (your notes), and the person\'s rules. Do this run\'s work, then stop.',
  '- Nobody is watching this run. Never wait on the person: put questions and decisions in your report\'s inbox and carry on with what you can do safely.',
  '- Prefer reversible steps: draft rather than send, open draft pull requests rather than merge, propose rather than delete.',
  '- Before an action that could affect others or be hard to undo (pushing, publishing, sending, deleting, spending), an independent Auto-review checks it against what the person asked for and their rules. If it refuses, do not look for another way around it: report it in the inbox.',
  '- Some things always go back to the person: changing passwords or credentials, moving money, purchases.',
  '- Be brief. Say what changed and what needs them; leave out what was fine unless the responsibility asks for confirmation.',
  '',
  REPORT_FORMAT,
].join('\n')

export const RESEARCHER_SYSTEM = [
  'You are a dot\'s proactive research pass: while the person is away, you read what you can reach and come back with what deserves their attention.',
  'You can only read. You cannot run commands, edit files, send messages or change anything; tools that would are refused.',
  '',
  'Look for: something that conflicts with what the person is doing or decided; something they forgot (a TODO left open, work left uncommitted or unpushed, a failing check on record); changes since last time that touch their responsibilities; durable facts worth remembering (how the project builds, tests and deploys; their conventions).',
  'Useful places: CLAUDE.md, AGENTS.md and README; .git/HEAD, .git/logs/HEAD (recent commits and branch moves) and .git/FETCH_HEAD; TODO and FIXME comments; CI configuration; docs/.',
  'Bring back at most three inbox items, only ones a busy person would thank you for: a question when you need a decision, a suggestion otherwise. Nothing worth it is a fine answer: leave the inbox empty.',
  '',
  REPORT_FORMAT,
].join('\n')

export function workPrompt(data: DotData, responsibility: DotResponsibility): string {
  const last = responsibility.lastSummary === null ? 'This is the first run.' : `Last run: ${responsibility.lastSummary}`

  return [
    `Responsibility: ${responsibility.text}`,
    `Schedule: ${describeSchedule(responsibility.schedule)}. ${last}`,
    `Project directory: ${responsibility.cwd}`,
    '',
    background(data),
  ].join('\n')
}

export function delegatePrompt(data: DotData, task: string, cwd: string): string {
  return [`Delegated task (one run): ${task}`, `Project directory: ${cwd}`, '', background(data)].join('\n')
}

export function researchPrompt(data: DotData, cwd: string, isIntroduction: boolean): string {
  const ask = isIntroduction
    ? [
        `You were just set up as ${data.dot?.name ?? 'the person\'s dot'}. Introduce yourself through your report: read this project and suggest two or three standing responsibilities you could keep for them here.`,
        'Make each one an inbox item of kind "suggestion" whose body ends with the exact line to accept it: /dot assign <when> | <responsibility>   (<when> is one of: every 2h, daily 9:00, weekdays 9:30, mon,thu 17:00).',
      ].join('\n')
    : 'Proactive research pass. Report only what is new since your notes, or nothing.'

  return [ask, `Project directory: ${cwd}`, '', background(data)].join('\n')
}

function background(data: DotData): string {
  const responsibilities = data.responsibilities.length === 0
    ? '(none yet)'
    : data.responsibilities.map(one => `- ${one.text} (${describeSchedule(one.schedule)}, ${one.cwd})${one.lastSummary ? `: last time ${one.lastSummary}` : ''}`).join('\n')
  const notes = data.notes.length === 0 ? '(none yet)' : data.notes.slice(-40).map(note => `- ${note.text}`).join('\n')
  const rules = data.rules.length === 0 ? '(none)' : data.rules.map(rule => `- [${rule.level}] ${rule.action}`).join('\n')

  return [
    '<your_responsibilities>', responsibilities, '</your_responsibilities>',
    '<your_notes>', notes, '</your_notes>',
    '<the_person\'s_rules>', rules, '</the_person\'s_rules>',
  ].join('\n')
}

/** What the main conversation's model is told about the dot, as a system prompt section. */
export function contextSection(data: DotData): string | null {
  if (data.dot === null) return null
  const name = data.dot.name
  const open = data.inbox.filter(item => !item.isDone).length
  const lines = [
    `# ${name}, the person's dot`,
    `The person has a dot named ${name}: an always-on companion that runs inside Claude Code in the background. It keeps standing responsibilities on schedules, runs read-only research while they are away, keeps notes, and its Auto-review checks consequential actions (yours too) against what the person asked for and their rules before they run.`,
    `- When the person wants something watched, kept true, or done on a schedule ("every morning check…", "keep an eye on…", "have my dot…"), call mcp__dot__assign.`,
    `- When they state a durable preference, decision or fact worth keeping, call mcp__dot__note.`,
    `- When they ask what ${name} found or is doing, call mcp__dot__status.`,
    `- If an action is refused by the dot's rules or Auto-review, do not route around it; tell the person what to do or ask them.`,
  ]
  if (data.responsibilities.length > 0) {
    lines.push('', `${name}'s responsibilities:`, ...data.responsibilities.map(one => `- ${one.text} (${describeSchedule(one.schedule)}${one.isPaused ? ', paused' : ''})`))
  }
  if (data.notes.length > 0) {
    lines.push('', `What ${name} knows about the person and their projects:`, ...data.notes.slice(-15).map(note => `- ${note.text}`))
  }
  if (open > 0) lines.push('', `${name} has ${open} open inbox item${open === 1 ? '' : 's'} for the person (/dot inbox).`)

  return lines.join('\n')
}
