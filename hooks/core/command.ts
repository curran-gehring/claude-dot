import type { DotRuleLevel, DotSchedule } from '../../types'
import { parseSchedule } from './schedule'

export type DotCommand =
  | { kind: 'open' }
  | { kind: 'help' }
  | { kind: 'setup' }
  | { kind: 'name'; name: string }
  | { kind: 'assign'; text: string; schedule: DotSchedule | null }
  | { kind: 'list' }
  | { kind: 'inbox' }
  | { kind: 'run' | 'pause' | 'resume' | 'drop' | 'unrule' | 'done'; index: number }
  | { kind: 'forget'; index: number | 'all' }
  | { kind: 'rule'; level: DotRuleLevel; action: string }
  | { kind: 'check'; index: number; command: string | null }
  | { kind: 'rules' }
  | { kind: 'note'; text: string }
  | { kind: 'notes' }
  | { kind: 'research' }
  | { kind: 'delegate'; text: string }
  | { kind: 'review' | 'band'; isOn: boolean }
  | { kind: 'sleep' | 'wake' | 'reset' }
  | { kind: 'error'; text: string }

const LEVELS: readonly DotRuleLevel[] = ['allow', 'when-asked', 'ask', 'handoff']
const NUMBERED = ['run', 'pause', 'resume', 'drop', 'unrule', 'done'] as const
const BARE = ['help', 'setup', 'inbox', 'list', 'rules', 'notes', 'research', 'sleep', 'wake', 'reset'] as const

export const HELP = [
  '/dot                         open your dot: what needs you, activity, responsibilities, rules, notes',
  '/dot setup                   name it and choose its look',
  '/dot assign [<when> |] <job> give it a standing responsibility; <when>: every 2h, daily 9:00, weekdays 9:30, mon,thu 17:00',
  '/dot list                    responsibilities, numbered',
  '/dot run|pause|resume|drop N act on responsibility N',
  '/dot check N <command>|off   run <command> before each automatic run of N; it starts only when the command exits 0',
  '/dot rule <level> <action>   level: allow, when-asked, ask, handoff; action: Bash(git push*), mcp__*__send*, or words',
  '/dot rules · /dot unrule N   list or remove rules',
  '/dot note <text> · /dot notes · /dot forget N|all   its notebook, which you can read',
  '/dot inbox · /dot done N     what it has for you; mark item N handled',
  '/dot research                run a read-only research pass on this project now',
  '/dot delegate <task>         hand a task to a background agent; the result lands in the inbox',
  '/dot review on|off · /dot band on|off · /dot sleep|wake · /dot reset',
].join('\n')

export function parseCommand(args: string): DotCommand {
  const said = args.trim()
  if (said === '') return { kind: 'open' }
  const [word = '', ...restWords] = said.split(/\s+/)
  const verb = word.toLowerCase()
  const rest = said.slice(word.length).trim()

  if ((BARE as readonly string[]).includes(verb)) return { kind: verb as (typeof BARE)[number] }
  if (verb === 'look' || verb === 'customize') return { kind: 'setup' }
  if ((NUMBERED as readonly string[]).includes(verb)) {
    const index = numberOf(rest)
    return index === null ? { kind: 'error', text: `/dot ${verb} takes a number from /dot list` } : { kind: verb as (typeof NUMBERED)[number], index }
  }
  if (verb === 'forget') {
    if (rest.toLowerCase() === 'all') return { kind: 'forget', index: 'all' }
    const index = numberOf(rest)
    return index === null ? { kind: 'error', text: '/dot forget takes a note number from /dot notes, or "all"' } : { kind: 'forget', index }
  }
  if (verb === 'name') return rest ? { kind: 'name', name: rest.slice(0, 40) } : { kind: 'error', text: '/dot name <name>' }
  if (verb === 'check') {
    const index = numberOf(restWords[0] ?? '')
    const command = rest.slice((restWords[0] ?? '').length).trim()
    if (index === null || command === '') return { kind: 'error', text: '/dot check N <command>, or /dot check N off' }
    return { kind: 'check', index, command: command.toLowerCase() === 'off' ? null : command }
  }
  if (verb === 'note') return rest ? { kind: 'note', text: rest } : { kind: 'error', text: '/dot note <text>' }
  if (verb === 'delegate') return rest ? { kind: 'delegate', text: rest } : { kind: 'error', text: '/dot delegate <task>' }
  if (verb === 'assign') return assign(rest)
  if (verb === 'rule') {
    const level = (restWords[0] ?? '').toLowerCase() as DotRuleLevel
    const action = rest.slice((restWords[0] ?? '').length).trim()
    if (!LEVELS.includes(level)) return { kind: 'error', text: `/dot rule <level> <action>: level is one of ${LEVELS.join(', ')}` }
    return action ? { kind: 'rule', level, action } : { kind: 'error', text: `/dot rule ${level} <action>` }
  }
  if (verb === 'review' || verb === 'band') {
    const toggle = rest.toLowerCase()
    return toggle === 'on' || toggle === 'off' ? { kind: verb, isOn: toggle === 'on' } : { kind: 'error', text: `/dot ${verb} on|off` }
  }

  return { kind: 'error', text: `/dot has no "${word}". The commands:\n${HELP}` }
}

function assign(rest: string): DotCommand {
  if (rest === '') return { kind: 'error', text: '/dot assign [<when> |] <responsibility>' }
  const bar = rest.indexOf('|')
  if (bar < 0) return { kind: 'assign', text: rest, schedule: null }

  const schedule = parseSchedule(rest.slice(0, bar))
  const text = rest.slice(bar + 1).trim()
  if ('error' in schedule) return { kind: 'error', text: schedule.error }
  return text ? { kind: 'assign', text, schedule } : { kind: 'error', text: '/dot assign <when> | <responsibility>: the responsibility is missing' }
}

function numberOf(text: string): number | null {
  return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : null
}
