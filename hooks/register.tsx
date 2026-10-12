import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DotActivity, DotData, DotIdentity, DotInboxItem, DotRule, DotSchedule } from '../types'
import { DEFAULT_LOOK, face } from './core/avatar'
import { HELP, parseCommand } from './core/command'
import type { DotCommand } from './core/command'
import { DotDataError, decodeData, emptyData } from './core/data'
import { addInbox, addNotes, addResponsibility, claimWork, dueResponsibilities, failWork, finishWork, reapStale } from './core/ops'
import type { Job } from './core/ops'
import { parseReport } from './core/report'
import { REVIEW_SYSTEM, buildReviewPrompt, parseVerdict } from './core/review'
import type { Review } from './core/review'
import { READ_ONLY_TOOLS, afterReview, decide } from './core/decide'
import type { Check } from './core/decide'
import { argOf } from './core/rules'
import { describeSchedule, nextRunAt, parseSchedule } from './core/schedule'
import { RESEARCHER_SYSTEM, WORKER_SYSTEM, contextSection, delegatePrompt, researchPrompt, workPrompt } from './prompts'
import { STORE_KEY, newId, offsetAt } from './state'
import { inboxText, notesText, openInbox, responsibilitiesText, rulesText, statusText } from './text'
import { band, look, pane } from './view'
import type { Actions } from './view'

/** The dot as this session last read it: what drawings and hot paths read. */
const DATA = atom({ plugin: 'dot', key: 'data' } as const, null)
/** The identity being edited in the setup pane, before it is saved. */
const DRAFT = atom({ plugin: 'dot', key: 'draft' } as const, null)

const MIN = 60_000
/** A lock this old was left by a session that died while holding it. */
const LOCK_STALE_MS = 30_000
/** How long a write waits for the lock before it fails loudly. */
const LOCK_WAIT_MS = 5_000
const LOCK_POLL_MS = 50
const PANE = 'dot'
const LOOK_PANE = 'dot-look'
const OWN_TOOL = 'mcp__dot__'
const WORKER = 'dot:worker'
const RESEARCHER = 'dot:researcher'

type $ = EngineInterface

// The module's own memory: lost on a reload, so everything that matters is
// also in the store (each activity carries its agent and its session).
const config = { proactiveMinutes: 120, idleMinutes: 10, reviewModel: 'haiku' }
const session = {
  id: 'unknown',
  cwd: '',
  isInteractive: false,
  lastPersonAt: 0,
  isMainTurnRunning: false,
  isTicking: false,
  ticker: null as { cancel: () => void } | null,
  /** Answers of agents that finished before the dot saved their id, by agent id. */
  unclaimed: new Map<string, { answer: string; isAborted: boolean }>(),
}
const MAX_UNCLAIMED = 50

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function nameOf(data: DotData): string {
  return data.dot?.name ?? 'Your dot'
}

// ── The store: the source of truth every session shares ────────────────

/**
 * Reads the stored dot. A value that does not decode is set aside (under the
 * store lock, like every write) and replaced by a fresh dot, said loudly, so
 * one bad write never leaves the guard or the scheduler dead.
 */
async function load($: $): Promise<DotData> {
  try {
    return decodeData(await $.store.get(STORE_KEY))
  } catch (error) {
    if (!(error instanceof DotDataError)) throw error
    return withLock($, () => readHeld($))
  }
}

/** Reads the store while holding the lock, setting aside a value that does not decode. */
async function readHeld($: $): Promise<DotData> {
  const raw = await $.store.get(STORE_KEY)
  try {
    return decodeData(raw)
  } catch (error) {
    if (!(error instanceof DotDataError)) throw error
    const backup = `corrupt-${await $.clock.now()}`
    await $.store.set(backup, raw)
    await $.store.set(STORE_KEY, emptyData())
    const said = `dot: its saved data did not read (${error.message}). It is kept under store key "${backup}"; the dot starts fresh.`
    $.ui.log(said)
    $.ui.toast(said)
    return emptyData()
  }
}

/** Where the lock lives: one directory every session on this machine sees. */
async function lockPath($: $): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return `${config ?? `${home}/.claude`}/plugins/dot.lock`.replace(/\\/g, '/')
}

/** Creates, renames or removes a directory on the host; true when it did. Each is atomic. */
async function directory($: $, op: 'make' | 'move' | 'remove', path: string, to = ''): Promise<boolean> {
  const isWindows = (await $.env.get('ComSpec')) !== undefined
  const native = (p: string) => (isWindows ? p.replace(/\//g, '\\') : p)
  const argv = {
    make: isWindows ? ['cmd', '/d', '/c', 'mkdir', native(path)] : ['mkdir', path],
    move: isWindows ? ['cmd', '/d', '/c', 'move', native(path), native(to)] : ['mv', path, to],
    remove: isWindows ? ['cmd', '/d', '/c', 'rmdir', '/s', '/q', native(path)] : ['rm', '-r', path],
  }[op]
  return (await $.process.run(argv, { timeoutMs: 10_000 })).exitCode === 0
}

async function ownerOf($: $, lock: string): Promise<string | null> {
  return $.fs.read(`${lock}/owner`).then(text => String(text), () => null)
}

/**
 * Breaks a lock judged stale, owned by `staleOwner`. The lock is renamed
 * aside first (atomic: of several breakers, one wins), then its owner is read:
 * the dead one's is removed; a lock that changed hands between the look and
 * the rename is put back for its live owner.
 */
async function breakStale($: $, lock: string, staleOwner: string | null): Promise<void> {
  const aside = `${lock}.broken-${newId()}`
  if (!(await directory($, 'move', lock, aside))) return
  if ((await ownerOf($, aside)) === staleOwner) {
    await directory($, 'remove', aside)
    return
  }
  if (!(await directory($, 'move', aside, lock))) {
    // Someone took the free lock meanwhile; the session we moved loses it at its fence, before writing.
    await directory($, 'remove', aside)
  }
}

/**
 * Runs `work` while this session alone holds the store. Every open session
 * shares one last-writer-wins store with get and set only, so a
 * read-modify-write needs real mutual exclusion: `mkdir` either creates the
 * lock directory or fails, atomically, for every process, and the holder
 * writes its token inside. A lock older than LOCK_STALE_MS belongs to a session
 * that died in its few milliseconds of work and is broken (breakStale). `work`
 * gets `isHeld`, the fence it checks right before writing, and the lock is
 * released only while it still carries this holder's token.
 */
async function withLock<T>($: $, work: (isHeld: () => Promise<boolean>) => Promise<T>): Promise<T> {
  const lock = await lockPath($)
  const token = newId()
  const startedAt = await $.clock.now()
  for (;;) {
    if (await directory($, 'make', lock)) {
      try {
        await $.fs.write(`${lock}/owner`, token)
      } catch (error) {
        // Ours has no owner file yet; release puts back a lock that is someone else's by now.
        await release($, lock, null)
        throw new Error(`dot: could not write the store lock's owner file (${messageOf(error)}); the change was not saved`)
      }
      break
    }
    const now = await $.clock.now()
    const held = await $.fs.stat(lock).catch(() => null)
    if (held !== null && now - held.mtimeMs > LOCK_STALE_MS) {
      await breakStale($, lock, await ownerOf($, lock))
      continue
    }
    if (now - startedAt > LOCK_WAIT_MS) {
      throw new Error(`dot: another session held the store lock (${lock}) for over ${LOCK_WAIT_MS / 1000}s; the change was not saved`)
    }
    await $.clock.sleep(LOCK_POLL_MS)
  }
  try {
    return await work(async () => (await ownerOf($, lock)) === token)
  } finally {
    await release($, lock, token)
  }
}

/**
 * Releases the lock only if it is still this holder's: renamed aside first
 * (atomic), then its token read, so a lock another session took after this
 * one went stale is put back for it rather than deleted.
 */
async function release($: $, lock: string, token: string | null): Promise<void> {
  const aside = `${lock}.released-${newId()}`
  if (!(await directory($, 'move', lock, aside))) return
  if ((await ownerOf($, aside)) === token) {
    await directory($, 'remove', aside)
    return
  }
  if (!(await directory($, 'move', aside, lock))) await directory($, 'remove', aside)
}

/** Reads the store, applies `change` and writes it back, holding the lock; redraws whoever reads it. */
async function mutate($: $, change: (data: DotData) => DotData): Promise<DotData> {
  const next = await withLock($, async isHeld => {
    const changed = change(await readHeld($))
    if (!(await isHeld())) throw new Error('dot: this session lost the store lock to another before writing; the change was not saved')
    await $.store.set(STORE_KEY, changed)
    return changed
  })
  await update($, DATA, () => next)
  return next
}

async function refresh($: $): Promise<DotData> {
  const data = await load($)
  await update($, DATA, () => data)
  return data
}

/** The session's copy, read from the store the first time. */
async function current($: $): Promise<DotData> {
  return (await read($, DATA)) ?? refresh($)
}

async function cwdOf($: $): Promise<string> {
  return session.cwd || $.session.cwd()
}

// ── Background work ────────────────────────────────────────────────────

async function startJob($: $, job: Job, prompt: string): Promise<string> {
  const now = await $.clock.now()
  const id = newId()
  const held = { isStarted: false }
  const data = await mutate($, d => {
    const claimed = claimWork(d, job, { now, offsetOf: offsetAt, id, sessionId: session.id })
    held.isStarted = claimed !== null
    return claimed?.data ?? d
  })
  if (!held.isStarted) return `${job.label} is already running.`

  const spawned = await $.agent
    .spawn({
      prompt,
      description: `${nameOf(data)}: ${job.label.slice(0, 40)}`,
      subagentType: job.kind === 'research' ? RESEARCHER : WORKER,
      cwd: job.cwd,
    })
    .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error), agentId: undefined }))
  if (spawned.deny !== undefined || spawned.agentId === undefined) {
    const reason = `could not start: ${spawned.deny ?? 'the engine gave no agent id'}`
    await mutate($, d => failWork(d, id, reason, now))
    $.ui.toast(`${nameOf(data)}: ${job.label} ${reason}`)
    return `${job.label} ${reason}`
  }

  const agentId = spawned.agentId
  await mutate($, d => ({ ...d, activity: d.activity.map(one => (one.id === id ? { ...one, agentId } : one)) }))
  const finished = session.unclaimed.get(agentId)
  if (finished !== undefined) {
    session.unclaimed.delete(agentId)
    await collect($, agentId, finished.answer, finished.isAborted)
    return `${nameOf(data)} finished: ${job.label}`
  }
  $.ui.toast(`${nameOf(data)} is on it: ${job.label}`)
  return `${nameOf(data)} started: ${job.label}`
}

async function collect($: $, agentId: string, answer: string, isAborted: boolean): Promise<void> {
  const known = await load($)
  if (!known.activity.some(one => one.status === 'running' && one.agentId === agentId)) {
    // Possibly a dot agent that finished before its id was saved: kept for startJob to collect.
    session.unclaimed.set(agentId, { answer, isAborted })
    if (session.unclaimed.size > MAX_UNCLAIMED) session.unclaimed.delete(session.unclaimed.keys().next().value ?? '')
    return
  }

  const now = await $.clock.now()
  const outcome = isAborted ? { error: 'it was stopped before it finished' } : parseReport(answer)
  const held: { summary: string | null; isFailed: boolean } = { summary: null, isFailed: false }
  const data = await mutate($, d => {
    const finished = finishWork(d, agentId, outcome, { now, newId })
    held.summary = finished?.activity.summary ?? null
    held.isFailed = finished?.activity.status === 'failed'
    return finished?.data ?? d
  })
  if (held.summary === null) return

  const name = nameOf(data)
  $.ui.toast(`${name}: ${held.summary}`)
  if (held.isFailed || ('needsYou' in outcome && outcome.needsYou)) {
    void $.ui.notify(held.summary, { title: name })
  }
}

async function tick($: $): Promise<void> {
  if (session.isTicking) return
  session.isTicking = true
  try {
    const now = await $.clock.now()
    const data = await mutate($, d => reapStale({ ...d, heartbeats: { ...d.heartbeats, [session.id]: now } }, now))
    if (data.dot === null || data.settings.isAsleep || !session.isInteractive) return

    for (const due of dueResponsibilities(data, now)) {
      await startJob($, { kind: 'work', responsibilityId: due.id, label: due.text, cwd: due.cwd }, workPrompt(data, due))
    }

    const isIdle = !session.isMainTurnRunning && now - session.lastPersonAt >= config.idleMinutes * MIN
    const isDue = now - (data.lastResearchAt[session.cwd] ?? 0) >= config.proactiveMinutes * MIN
    if (config.proactiveMinutes > 0 && isIdle && isDue) {
      await startJob($, { kind: 'research', responsibilityId: null, label: 'Proactive research', cwd: session.cwd }, researchPrompt(data, session.cwd, false))
    }
  } catch (error) {
    // A busy lock or a failed spawn: the next tick tries again.
    $.ui.log(`dot: scheduler tick: ${messageOf(error)}`, { to: 'debug' })
  } finally {
    session.isTicking = false
  }
}

// ── Auto-review and approvals ──────────────────────────────────────────

async function recentAsks($: $): Promise<string[]> {
  try {
    const messages = await $.session.messages()
    return messages.filter(one => one.role === 'user' && one.text.trim() !== '').slice(-3).map(one => one.text)
  } catch {
    return []
  }
}

async function autoReview($: $, tool: string, input: unknown, request: readonly string[], rules: readonly DotRule[], matched: DotRule | undefined): Promise<Review> {
  const answered = await $.model.complete({
    model: config.reviewModel,
    system: REVIEW_SYSTEM,
    prompt: buildReviewPrompt({ tool, input, request, rules, matchedRule: matched }),
    maxTokens: 300,
    timeoutMs: 30_000,
  })
  if (!answered.isAnswered) return { verdict: 'ask', reason: `Auto-review could not answer (${answered.reason})` }

  return parseVerdict(answered.text) ?? { verdict: 'ask', reason: 'Auto-review gave no clear verdict' }
}

/** Puts the call to the person in the engine's own question dialog; headless, the mode decides. */
async function askPerson($: $, data: DotData, tool: string, input: unknown, why: string): Promise<Check> {
  if ((await $.session.surface()) === null) return { decision: 'ask', reason: why }
  const what = `${tool}: ${argOf(tool, input).slice(0, 160)}`
  try {
    const answer = await $.ui.ask(`${what}. ${why}. Let it run?`, {
      header: nameOf(data).slice(0, 12),
      options: ['Approve', 'Deny', 'Hand off to me'],
    })
    if (answer === 'Approve') return { decision: 'allow', reason: `the person approved it (${why})` }
    if (answer === 'Hand off to me') return { decision: 'deny', reason: 'The person will do this themselves. Tell them exactly what to run or do, then carry on without it.' }
    return { decision: 'deny', reason: answer === 'Deny' ? `The person declined it (${why}).` : `The person declined it and said: ${answer}` }
  } catch {
    return { decision: 'deny', reason: 'The approval was dismissed, so it did not run.' }
  }
}

async function report($: $, kind: DotInboxItem['kind'], tool: string, input: unknown, body: string): Promise<void> {
  const now = await $.clock.now()
  const title = `${kind === 'blocked' ? 'Blocked' : 'Handed to you'}: ${tool} ${argOf(tool, input).slice(0, 80)}`
  await mutate($, d => addInbox(d, [{ kind, title, body }], { now, newId }))
}

/**
 * Whether a call comes from the dot's research agent. The engine's own record
 * of the agent's type decides, so a call made before the dot recorded the
 * agent's id (it is spawned first) is still held to read-only.
 */
async function isResearchAgent($: $, agentId: string | undefined, job: DotActivity | undefined): Promise<boolean> {
  if (agentId === undefined) return false
  if (job !== undefined) return job.kind === 'research'
  const agents = await $.agent.list()
  return agents.find(one => one.id === agentId)?.type === RESEARCHER
}

async function guard($: $, tool: string, input: unknown, agentId: string | undefined, isCall: boolean, base: Check): Promise<Check> {
  // Always the store, never the session's copy: a rule added in another session applies at once.
  const data = await load($)
  const job = agentId === undefined ? undefined : data.activity.find(one => one.agentId === agentId)
  const cwd = job?.cwd ?? (await cwdOf($))
  let step = decide(data, { tool, input, isResearch: await isResearchAgent($, agentId, job), isCall, cwd, base })
  if (step.kind === 'review') {
    const request = job ? [job.label] : await recentAsks($)
    step = afterReview(await autoReview($, tool, input, request, data.rules, step.rule), step.rule, base)
  }
  if (step.kind === 'ask') return askPerson($, data, tool, input, step.why)
  if (step.kind === 'report') await report($, step.inbox, tool, input, step.body)
  return step.kind === 'review' ? base : step.check
}

// ── Responsibilities, setup, commands ──────────────────────────────────

async function assign($: $, text: string, schedule: DotSchedule | null): Promise<string> {
  const now = await $.clock.now()
  const cwd = await cwdOf($)
  const data = await mutate($, d => addResponsibility(d, { text, schedule, cwd }, { now, offsetOf: offsetAt, id: newId() }))
  return `${nameOf(data)} will keep this: ${text} (${describeSchedule(schedule)}).`
}

async function setPaused($: $, id: string, isPaused: boolean): Promise<void> {
  const now = await $.clock.now()
  await mutate($, d => ({
    ...d,
    responsibilities: d.responsibilities.map(one =>
      one.id !== id ? one : { ...one, isPaused, nextRunAt: isPaused || one.schedule === null ? one.nextRunAt : nextRunAt(one.schedule, now, offsetAt) }),
  }))
}

async function markDone($: $, id: string): Promise<void> {
  await mutate($, d => ({ ...d, inbox: d.inbox.map(item => (item.id === id ? { ...item, isDone: true } : item)) }))
}

async function runResponsibility($: $, id: string): Promise<string> {
  const data = await current($)
  const one = data.responsibilities.find(r => r.id === id)
  if (one === undefined) return 'That responsibility is gone.'
  return startJob($, { kind: 'work', responsibilityId: one.id, label: one.text, cwd: one.cwd }, workPrompt(data, one))
}

async function openLook($: $): Promise<void> {
  const data = await current($)
  const now = await $.clock.now()
  const draft: DotIdentity = data.dot ?? { name: 'Dot', look: DEFAULT_LOOK, createdAt: now }
  await update($, DRAFT, () => draft)
  await $.ui.open({ id: LOOK_PANE, title: data.dot ? `${data.dot.name}'s look` : 'Meet your dot', focus: true, closeOnEscape: true })
}

async function openDot($: $): Promise<boolean> {
  const data = await refresh($)
  const opened = await $.ui.open({ id: PANE, title: nameOf(data) })
  return opened.isPlaced
}

async function saveDraft($: $): Promise<void> {
  const draft = await read($, DRAFT)
  if (draft === null) return
  const name = draft.name.trim().slice(0, 40) || 'Dot'
  const before = await current($)
  const data = await mutate($, d => ({ ...d, dot: { ...draft, name } }))
  await $.ui.close({ id: LOOK_PANE })
  await update($, DRAFT, () => null)
  if (before.dot !== null) {
    $.ui.toast(`${name} looks like this now: ${face(draft.look, 'idle')}`)
    return
  }
  $.ui.toast(`${face(draft.look, 'idle')} ${name} is here. It will look around and suggest where it can help.`)
  if (session.isInteractive) {
    const cwd = await cwdOf($)
    await startJob($, { kind: 'research', responsibilityId: null, label: 'Getting to know this project', cwd }, researchPrompt(data, cwd, true))
  }
}

function at<T>(list: readonly T[], index: number, what: string): T | string {
  return list[index - 1] ?? `There is no ${what} ${index}.`
}

async function runCommand($: $, command: DotCommand): Promise<string> {
  const now = await $.clock.now()
  const offset = offsetAt
  const data = await refresh($)
  const name = nameOf(data)

  switch (command.kind) {
    case 'error':
      return command.text
    case 'help':
      return HELP
    case 'open':
      return (await openDot($)) ? `Opened ${name}.` : statusText(data, now, offset)
    case 'setup':
      await openLook($)
      return data.dot ? `Change ${name}'s name and look in the pane.` : 'Name your dot and choose its look in the pane.'
    case 'name': {
      const next = await mutate($, d => ({ ...d, dot: { ...(d.dot ?? { look: DEFAULT_LOOK, createdAt: now }), name: command.name } }))
      return `${face(next.dot?.look ?? DEFAULT_LOOK, 'idle')} It answers to ${command.name} now.`
    }
    case 'assign':
      return assign($, command.text, command.schedule)
    case 'list':
      return responsibilitiesText(data, now, offset)
    case 'inbox':
      return inboxText(data, now)
    case 'rules':
      return rulesText(data)
    case 'notes':
      return notesText(data, now)
    case 'run': {
      const one = at(data.responsibilities, command.index, 'responsibility')
      return typeof one === 'string' ? one : runResponsibility($, one.id)
    }
    case 'pause':
    case 'resume': {
      const one = at(data.responsibilities, command.index, 'responsibility')
      if (typeof one === 'string') return one
      await setPaused($, one.id, command.kind === 'pause')
      return `${command.kind === 'pause' ? 'Paused' : 'Resumed'}: ${one.text}`
    }
    case 'drop': {
      const one = at(data.responsibilities, command.index, 'responsibility')
      if (typeof one === 'string') return one
      await mutate($, d => ({ ...d, responsibilities: d.responsibilities.filter(r => r.id !== one.id) }))
      return `Dropped: ${one.text}`
    }
    case 'rule': {
      const rule: DotRule = { id: newId(), level: command.level, action: command.action }
      await mutate($, d => ({ ...d, rules: [...d.rules, rule] }))
      return `Rule added: [${rule.level}] ${rule.action}`
    }
    case 'unrule': {
      const one = at(data.rules, command.index, 'rule')
      if (typeof one === 'string') return one
      await mutate($, d => ({ ...d, rules: d.rules.filter(r => r.id !== one.id) }))
      return `Rule removed: [${one.level}] ${one.action}`
    }
    case 'note':
      await mutate($, d => addNotes(d, [command.text], 'you', { now, newId }))
      return `${name} noted it.`
    case 'forget': {
      if (command.index === 'all') {
        await mutate($, d => ({ ...d, notes: [] }))
        return `${name} forgot every note.`
      }
      const one = at(data.notes, command.index, 'note')
      if (typeof one === 'string') return one
      await mutate($, d => ({ ...d, notes: d.notes.filter(n => n.id !== one.id) }))
      return `Forgot: ${one.text}`
    }
    case 'done': {
      const one = at(openInbox(data), command.index, 'inbox item')
      if (typeof one === 'string') return one
      await markDone($, one.id)
      return `Done: ${one.title}`
    }
    case 'research': {
      const cwd = await cwdOf($)
      return startJob($, { kind: 'research', responsibilityId: null, label: 'Research on request', cwd }, researchPrompt(data, cwd, false))
    }
    case 'delegate': {
      const cwd = await cwdOf($)
      return startJob($, { kind: 'delegate', responsibilityId: null, label: command.text.slice(0, 80), cwd }, delegatePrompt(data, command.text, cwd))
    }
    case 'review':
      await mutate($, d => ({ ...d, settings: { ...d.settings, isAutoReview: command.isOn } }))
      return `Auto-review is ${command.isOn ? 'on' : 'off'}.`
    case 'band':
      await mutate($, d => ({ ...d, settings: { ...d.settings, isBandShown: command.isOn } }))
      return `The band above the prompt is ${command.isOn ? 'shown' : 'hidden'}.`
    case 'sleep':
    case 'wake':
      await mutate($, d => ({ ...d, settings: { ...d.settings, isAsleep: command.kind === 'sleep' } }))
      return command.kind === 'sleep' ? `${name} is asleep: no scheduled work or research until /dot wake.` : `${name} is awake.`
    case 'reset': {
      const answer = await $.ui.ask(`Reset ${name}: delete its responsibilities, rules, notes, inbox and history?`, ['Keep it', 'Reset']).catch(() => 'Keep it')
      if (answer !== 'Reset') return `${name} stays as it is.`
      await mutate($, () => emptyData())
      return 'Your dot is reset. /dot setup to meet a new one.'
    }
  }
}

/** What the drawings' buttons do. */
function actions($: $): Actions {
  return {
    openDot: () => void openDot($),
    openLook: () => void openLook($),
    markDone: id => void markDone($, id),
    askClaude: item => void $.prompt.fill({ text: `${item.title}\n\n${item.body}\n\n`, mode: 'replace' }),
    runNow: id => void runResponsibility($, id),
    togglePause: id => void current($).then(data => setPaused($, id, !data.responsibilities.find(r => r.id === id)?.isPaused)),
    drop: id => void mutate($, d => ({ ...d, responsibilities: d.responsibilities.filter(r => r.id !== id) })),
    removeRule: id => void mutate($, d => ({ ...d, rules: d.rules.filter(r => r.id !== id) })),
    forget: id => void mutate($, d => ({ ...d, notes: d.notes.filter(n => n.id !== id) })),
    wake: () => void mutate($, d => ({ ...d, settings: { ...d.settings, isAsleep: false } })),
    editDraft: change => void update($, DRAFT, draft => change(draft ?? { name: 'Dot', look: DEFAULT_LOOK, createdAt: 0 })),
    saveDraft: () => void saveDraft($),
  }
}

async function registerSurface($: $): Promise<void> {
  await $.command.register({
    name: 'dot',
    description: 'Your dot: an always-on companion that keeps responsibilities, researches while you are away, and reviews risky actions',
    argumentHint: 'assign | list | inbox | rule | notes | research | delegate | setup | help',
  })
  await $.tool.register({
    name: 'assign',
    description: 'Give the person\'s dot a standing responsibility it keeps true in the background, optionally on a schedule. Use when the person wants something watched, kept up to date, or done regularly.',
    inputSchema: {
      type: 'object',
      properties: {
        responsibility: { type: 'string', description: 'What to keep true or do, with where to look and what deserves the person\'s attention. One or two sentences.' },
        schedule: { type: 'string', description: 'Optional: every 30m | every 2h | hourly | daily 9:00 | weekdays 9:30 | weekends 8am | mon,thu 17:00 (local time). Leave out to let the dot decide when to check.' },
      },
      required: ['responsibility'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'note',
    description: 'Save a durable fact to the person\'s dot\'s notebook: a preference, a decision, where something lives. Not for task progress.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'status',
    description: 'Read what the person\'s dot is doing and has found: its inbox, running work, responsibilities and recent results.',
    inputSchema: { type: 'object', properties: {} },
    isDeferred: false,
  })
  await $.agent.register({ name: 'worker', description: 'The dot\'s background worker. Spawned by the dot only.', prompt: WORKER_SYSTEM })
  await $.agent.register({
    name: 'researcher',
    description: 'The dot\'s read-only proactive research. Spawned by the dot only.',
    prompt: RESEARCHER_SYSTEM,
    tools: [...READ_ONLY_TOOLS].filter(tool => tool !== 'TodoWrite'),
    model: 'sonnet',
  })
}

export const register: Register = (on, options) => {
  config.proactiveMinutes = Number(options.proactiveMinutes ?? 120)
  config.idleMinutes = Number(options.idleMinutes ?? 10)
  config.reviewModel = String(options.reviewModel ?? 'haiku')

  on('tool.check', async ($, e, next) => {
    const base = await next(e)
    if (e.tool.startsWith(OWN_TOOL)) return base.decision === 'deny' ? base : { decision: 'allow', reason: 'the dot’s own tool' }
    return guard($, e.tool, e.input, e.agentId, e.tool_use_id !== undefined, base)
  }).catch(($, e, next) =>
    // Our own approval dialog (AskUserQuestion) re-enters here: let it through.
    next.error.kind === 're-entry' && e.tool === 'AskUserQuestion'
      ? next(e)
      : { decision: 'ask', reason: 'dot: its guard failed, so this goes to you' })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    session.id = await $.session.id()
    session.cwd = e.cwd
    session.isInteractive = e.isInteractive
    session.lastPersonAt = await $.clock.now()
    await registerSurface($)

    const now = await $.clock.now()
    await mutate($, d => reapStale({ ...d, heartbeats: { ...d.heartbeats, [session.id]: now } }, now))
    session.ticker?.cancel()
    session.ticker = session.isInteractive ? $.clock.every(MIN, () => void tick($)) : null

    return started
  })

  on('session.end', async ($, e, next) => {
    session.ticker?.cancel()
    session.ticker = null
    session.isInteractive = false
    // Let other sessions see at once that work started here will not finish.
    await mutate($, d => {
      const { [session.id]: _gone, ...heartbeats } = d.heartbeats
      return { ...d, heartbeats }
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    session.lastPersonAt = await $.clock.now()
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    session.isMainTurnRunning = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      session.isMainTurnRunning = false
      session.lastPersonAt = await $.clock.now()
    } else {
      await collect($, e.agentId, e.answer, e.isAborted)
    }
    return next(e)
  })

  on('agent.offer', ($, e, next) => (e.agent === WORKER || e.agent === RESEARCHER ? { isOffered: false } : next(e)))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const text = contextSection(await current($))
    return text === null ? composed : { sections: [...composed.sections, { id: 'dot:context', text, scope: 'session' as const }] }
  })

  on('tool.call', { tool: 'mcp__dot__assign' }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    if (typeof args.responsibility !== 'string' || args.responsibility.trim() === '') return { deny: 'responsibility must be a non-empty string' }
    if (args.schedule !== undefined && typeof args.schedule !== 'string') return { deny: 'schedule must be a string' }
    const said = typeof args.schedule === 'string' && args.schedule.trim() !== '' ? parseSchedule(args.schedule) : null
    if (said !== null && 'error' in said) return { deny: said.error }

    try {
      return { result: await assign($, args.responsibility.trim(), said) }
    } catch (error) {
      return { deny: messageOf(error) }
    }
  })

  on('tool.call', { tool: 'mcp__dot__note' }, async ($, e) => {
    const text = (e as unknown as Record<string, unknown>).text
    if (typeof text !== 'string' || text.trim() === '') return { deny: 'text must be a non-empty string' }
    const now = await $.clock.now()
    try {
      const data = await mutate($, d => addNotes(d, [text], 'you', { now, newId }))
      return { result: `${nameOf(data)} noted it.` }
    } catch (error) {
      return { deny: messageOf(error) }
    }
  })

  on('tool.call', { tool: 'mcp__dot__status' }, async $ => {
    const now = await $.clock.now()
    return { result: statusText(await refresh($), now, offsetAt) }
  })

  on('command.run', { command: 'dot' }, async ($, e) => {
    try {
      return { text: await runCommand($, parseCommand(e.args)) }
    } catch (error) {
      // Said as the command's output, not swallowed: nothing was saved.
      return { text: messageOf(error) }
    }
  })

  // A drawing never writes: it reads the session's copy, or the store directly.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const data = (await read($, DATA)) ?? (await load($))
    if (e.props.hasSurvey || !data.settings.isBandShown) return next(e)
    const now = await $.clock.now()
    return band($.ui.resolve(e), data, now, offsetAt, actions($))
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const data = (await read($, DATA)) ?? (await load($))
    const now = await $.clock.now()
    const user = (await $.env.get('USERNAME')) ?? (await $.env.get('USER'))
    return pane($.ui.resolve(e), data, now, offsetAt, user, actions($))
  })

  on('ui.render', { component: 'Pane', requestId: LOOK_PANE }, async ($, e) => {
    const draft = (await read($, DRAFT)) ?? { name: 'Dot', look: DEFAULT_LOOK, createdAt: 0 }
    return look($.ui.resolve(e), e.surface, draft, actions($))
  })
}
