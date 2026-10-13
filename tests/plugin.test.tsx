import { describe, expect, mock, test } from 'claude-code/testing'

import { DEFAULT_LOOK } from '../hooks/core/avatar'
import { emptyData } from '../hooks/core/data'
import type { CommandRunInput, On } from 'claude-code'

import type { DotData, DotRule } from '../types'

const NOW = Date.UTC(2026, 9, 12, 8)

function stored(change: Partial<DotData> = {}): DotData {
  return { ...emptyData(), dot: { name: 'Alfred', look: DEFAULT_LOOK, createdAt: NOW }, ...change }
}

/** What a session answers beneath the plugin: the time, the project and the stored dot. */
function given(on: On, data: DotData | undefined, env: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, data === undefined ? {} : { data })
  on('session.cwd', () => ({ value: 'C:/Dev/app' }))
  on('env.get', (_$, e) => ({ value: ({ HOME: '/home/me', USERNAME: 'Curran', ...env } as Record<string, string>)[e.name] }))
  // The store lock is always free here; the sharing tests below hold it.
  const owner = { token: '' }
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.write', (_$, e) => {
    owner.token = e.text
    return { value: undefined }
  })
  on('fs.read', () => ({ value: owner.token }))
  return clock
}

/** `/dot <args>` as the person would type it. */
function dot(args: string): CommandRunInput {
  return { command: 'dot', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }
}

function rule(level: DotRule['level'], action: string): DotRule {
  return { id: `rule-${action}`, level, action }
}

describe('the guard', () => {
  test('a handoff rule refuses the call and says who does it', async ($, on) => {
    given(on, stored({ rules: [rule('handoff', 'Bash(git push --force*)')] }))
    on('tool.check', () => ({ decision: 'allow' }))

    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'git push --force origin main' } })

    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('Hand off')
  })

  test('an ask rule asks', async ($, on) => {
    given(on, stored({ rules: [rule('ask', 'mcp__*__send*')] }))
    on('tool.check', () => ({ decision: 'allow' }))

    const verdict = await $.tool.check({ tool: 'mcp__claude_ai_Gmail__send_message', input: {} })

    expect(verdict.decision).toBe('ask')
  })

  test('an allow rule lets a plain call through without review', async ($, on) => {
    given(on, stored({ rules: [rule('allow', 'Bash(pnpm test*)')] }))
    on('tool.check', () => ({ decision: 'ask' }))

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'pnpm test' } })).decision).toBe('allow')
  })

  test('the person’s own settings deny is never loosened', async ($, on) => {
    given(on, stored({ rules: [rule('allow', 'Bash(*)')] }))
    on('tool.check', () => ({ decision: 'deny', reason: 'settings' }))

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('deny')
  })

  test('the dot’s own tools need no permission', async ($, on) => {
    given(on, stored())
    on('tool.check', () => ({ decision: 'ask' }))

    expect((await $.tool.check({ tool: 'mcp__dot__note', input: { text: 'x' } })).decision).toBe('allow')
  })
})

describe('/dot', () => {
  test('assign, list, pause and drop a responsibility', async ($, on) => {
    given(on, stored())

    const assigned = await $.command.run(dot('assign weekdays 9:00 | Check CI on main'))
    expect(assigned.text).toContain('Check CI on main')
    expect(assigned.text).toContain('weekdays 09:00')

    expect((await $.command.run(dot('list'))).text).toContain('1. Check CI on main')
    expect((await $.command.run(dot('pause 1'))).text).toContain('Paused')
    expect((await $.command.run(dot('list'))).text).toContain('paused')
    expect((await $.command.run(dot('drop 1'))).text).toContain('Dropped')
    expect((await $.command.run(dot('list'))).text).toContain('no responsibilities')
  })

  test('a pre-check is set, shown and cleared', async ($, on) => {
    given(on, stored())
    await $.command.run(dot('assign every 15m | Read agent mail'))

    expect((await $.command.run(dot('check 1 sh ~/.claude/dot/mail-check.sh'))).text).toContain('checks first')
    expect((await $.command.run(dot('list'))).text).toContain('checks first: `sh ~/.claude/dot/mail-check.sh`')
    expect((await $.command.run(dot('check 1 off'))).text).toContain('no longer checks')
    expect((await $.command.run(dot('list'))).text).not.toContain('checks first')
    expect((await $.command.run(dot('check 9 sh x.sh'))).text).toContain('There is no responsibility 9')
  })

  test('notes are readable and forgettable', async ($, on) => {
    given(on, stored())

    await $.command.run(dot('note Prefers pnpm over npm'))
    expect((await $.command.run(dot('notes'))).text).toContain('1. Prefers pnpm over npm')
    await $.command.run(dot('forget 1'))
    expect((await $.command.run(dot('notes'))).text).not.toContain('pnpm')
  })

  test('a mistyped command says what exists', async ($, on) => {
    given(on, stored())

    expect((await $.command.run(dot('dance'))).text).toContain('/dot assign')
  })
})

describe('the dot’s own tools', () => {
  const item = (id: string, title: string) => ({ id, at: NOW, kind: 'blocked' as const, title, body: 'b', isUrgent: false, isDone: false })
  // A refusal comes back as { deny }, an answer as { result }.
  const call = async ($: { tool: { call: (input: never) => Promise<unknown> } }, tool: string, input: Record<string, unknown> = {}) => {
    const out = (await $.tool.call({ tool: `mcp__dot__${tool}`, ...input } as never)) as { deny?: string, result?: unknown }
    return out.deny !== undefined ? { text: out.deny, isError: true } : { text: String(out.result), isError: false }
  }

  test('status lists the rules, numbered, so they can be named', async ($, on) => {
    given(on, stored({ rules: [rule('allow', 'git push to main'), rule('handoff', 'Bash(gh pr merge*)')] }))
    const { text } = await call($, 'status')
    expect(text).toContain('Rules:')
    expect(text).toContain('1. [allow] git push to main')
    expect(text).toContain('2. [handoff]')
  })

  test('resolve marks the named inbox item handled', async ($, on) => {
    given(on, stored({ inbox: [item('i1', 'PR28 log'), item('i2', 'Checklists not pushed')] }))
    const out = await call($, 'resolve', { item: 2, title: 'Checklists not pushed' })
    expect(out.isError ?? false).toBe(false)
    const inbox = (await $.command.run(dot('inbox'))).text
    expect(inbox).toContain('PR28 log')
    expect(inbox).not.toContain('Checklists not pushed')
  })

  test('resolve refuses when the number no longer points at that title', async ($, on) => {
    given(on, stored({ inbox: [item('i1', 'PR28 log')] }))
    expect((await call($, 'resolve', { item: 1, title: 'Something else' })).isError).toBe(true)
    expect((await call($, 'resolve', { item: 3, title: 'PR28 log' })).isError).toBe(true)
    expect((await $.command.run(dot('inbox'))).text).toContain('PR28 log')
  })

  test('unrule removes an allow rule it names', async ($, on) => {
    given(on, stored({ rules: [rule('allow', 'sudo cat of one log'), rule('allow', 'git push to main')] }))
    const out = await call($, 'unrule', { rule: 1, action: 'sudo cat of one log' })
    expect(out.isError ?? false).toBe(false)
    const rules = (await $.command.run(dot('rules'))).text
    expect(rules).not.toContain('sudo cat')
    expect(rules).toContain('git push to main')
  })

  test('unrule never removes a rule that holds the dot back', async ($, on) => {
    given(on, stored({ rules: [rule('handoff', 'Bash(gh pr merge*)'), rule('ask', 'send email'), rule('when-asked', 'deploy')] }))
    for (const [n, action] of [[1, 'Bash(gh pr merge*)'], [2, 'send email'], [3, 'deploy']] as const) {
      const out = await call($, 'unrule', { rule: n, action })
      expect(out.isError).toBe(true)
      expect(out.text).toContain('/dot unrule')
    }
    expect((await $.command.run(dot('rules'))).text).toContain('3. [when-asked] deploy')
  })

  test('unrule refuses a stale number', async ($, on) => {
    given(on, stored({ rules: [rule('allow', 'git push to main')] }))
    expect((await call($, 'unrule', { rule: 1, action: 'sudo cat' })).isError).toBe(true)
    expect((await $.command.run(dot('rules'))).text).toContain('git push to main')
  })
})

describe('the band', () => {
  const BAND = {
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  } as const

  test('shows the dot, what it watches and what needs you', async ($, on) => {
    const inbox = [{ id: 'i1', at: NOW, kind: 'question', title: 'Revert #41?', body: 'b', isUrgent: false, isDone: false }] as const
    given(on, stored({ inbox: [...inbox] }))

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'dot', surface, ...BAND })
      expect(await ui.find({ text: /\(•o•\)!/ })).toBeDefined()
      expect(await ui.find({ text: /Alfred/ })).toBeDefined()
      expect(await ui.find({ text: /1 needs you/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('before setup it invites you to meet your dot', async ($, on) => {
    given(on, undefined)

    const ui = await $.ui.mount({ plugin: 'dot', surface: 'terminal', ...BAND })
    expect(await ui.find({ text: /Meet your dot/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('the panes', () => {
  const PANE_PROPS = { title: 'Alfred', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
  const full = stored({
    responsibilities: [{
      id: 'r1', text: 'Check CI on main', schedule: { kind: 'interval', minutes: 60 }, cwd: 'C:/Dev/app', createdAt: NOW,
      nextRunAt: NOW + 60_000 * 60, lastRunAt: null, lastSummary: 'all green', isPaused: false, check: null,
    }],
    rules: [rule('handoff', 'Bash(gh pr merge*)')],
    notes: [{ id: 'n1', at: NOW, text: 'Prefers pnpm', source: 'you' }],
    inbox: [{ id: 'i1', at: NOW, kind: 'question', title: 'Revert #41?', body: 'It broke login.', isUrgent: false, isDone: false }],
  })

  test('the dot pane draws every section on every surface', async ($, on) => {
    given(on, full)

    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ plugin: 'dot', surface, component: 'Pane', requestId: 'dot', props: PANE_PROPS })
      expect(await ui.find({ text: /@curran-alfred/ })).toBeDefined()
      expect(await ui.find({ text: /Revert #41\?/ })).toBeDefined()
      expect(await ui.find({ text: /Check CI on main/ })).toBeDefined()
      expect(await ui.find({ text: /gh pr merge/ })).toBeDefined()
      expect(await ui.find({ text: /Prefers pnpm/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('Done on an inbox item clears it', async ($, on) => {
    given(on, full)

    const ui = await $.ui.mount({ plugin: 'dot', surface: 'terminal', component: 'Pane', requestId: 'dot', props: PANE_PROPS })
    await ui.press({ key: 'done-i1' })
    expect((await $.command.run(dot('inbox'))).text).toContain('Nothing for you')
    await ui.unmount()
  })

  test('the setup pane previews the look as you pick it', async ($, on) => {
    given(on, undefined)

    // The draft is shared state, so each surface picks a new shape from where the last left it.
    const picks = [['terminal', 'square', /\[•ᴗ•\]/], ['desktop', 'soft', /\{•ᴗ•\}/]] as const
    for (const [surface, shape, drawn] of picks) {
      const ui = await $.ui.mount({ plugin: 'dot', surface, component: 'Pane', requestId: 'dot-look', props: { ...PANE_PROPS, title: 'Meet your dot' } })
      await ui.select({ key: 'look-shape', value: shape })
      expect(await ui.find({ text: drawn })).toBeDefined()
      await ui.unmount()
    }
    const phone = await $.ui.mount({ plugin: 'dot', surface: 'mobile', component: 'Pane', requestId: 'dot-look', props: { ...PANE_PROPS, title: 'Meet your dot' } })
    expect(await phone.find({ text: /terminal or the desktop/ })).toBeDefined()
    await phone.unmount()
  })
})

describe('sharing the store with other sessions', () => {
  const LOCK = '/home/me/.claude/plugins/dot.lock'
  type Dir = { mtimeMs: number; owner: string | null }

  /**
   * The host beneath the plugin: an in-memory store, and directories that
   * `mkdir`, `mv` and `rm -r` change atomically, so a test can hold, orphan or
   * swap the lock. `onRun` plays another session between two of ours.
   */
  /** The kit hands fs paths over resolved (C:\home\me\...); the host keys them as written. */
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

  type Spies = { failOwnerWrite?: boolean; onRun?: (argv: readonly string[], dirs: Map<string, Dir>) => void; onGet?: (dirs: Map<string, Dir>) => void | Promise<void>; onSet?: (key: string, dirs: Map<string, Dir>) => void }

  function host(on: On, initial: DotData, spies: Spies = {}) {
    const store = new Map<string, unknown>([['data', initial]])
    const dirs = new Map<string, Dir>()
    const clock = mock.clock(on, { now: NOW })
    const done = (exitCode: number) => ({ value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    on('store.get', async (_$, e) => {
      await spies.onGet?.(dirs)
      return { value: structuredClone(store.get(e.key)) }
    })
    on('store.set', (_$, e) => {
      spies.onSet?.(e.key, dirs)
      store.set(e.key, structuredClone(e.value))
      return { value: undefined }
    })
    on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
    on('process.run', (_$, e) => {
      spies.onRun?.(e.argv, dirs)
      const [verb, ...rest] = e.argv
      const target = norm(rest[rest.length - 1] ?? '')
      if (verb === 'mkdir') {
        if (dirs.has(target)) return done(1)
        dirs.set(target, { mtimeMs: clock.now(), owner: null })
        return done(0)
      }
      if (verb === 'mv') {
        const [from = '', to = ''] = rest.map(norm)
        const moving = dirs.get(from)
        if (moving === undefined || dirs.has(to)) return done(1)
        dirs.delete(from)
        dirs.set(to, moving)
        return done(0)
      }
      if (verb === 'rm') return done(dirs.delete(target) ? 0 : 1)
      throw new Error(`unexpected command ${e.argv.join(' ')}`)
    })
    on('fs.write', (_$, e) => {
      if (spies.failOwnerWrite) throw new Error(`cannot write the owner file ${e.path}`)
      const dir = dirs.get(norm(e.path).replace(/\/owner$/, ''))
      if (dir === undefined) throw new Error(`no such directory for ${e.path}`)
      dir.owner = e.text
      dir.mtimeMs = clock.now()
      return { value: undefined }
    })
    on('fs.read', (_$, e) => {
      const owner = dirs.get(norm(e.path).replace(/\/owner$/, ''))?.owner
      if (owner === undefined || owner === null) throw new Error(`no such file: ${e.path}`)
      return { value: owner }
    })
    on('fs.stat', (_$, e) => {
      const dir = dirs.get(norm(e.path))
      if (dir === undefined) throw new Error(`no such file: ${e.path}`)
      return { value: { kind: 'dir', size: 0, mtimeMs: dir.mtimeMs, isLink: false } }
    })
    on('session.cwd', () => ({ value: 'C:/Dev/app' }))
    return { store, dirs, clock }
  }

  const notes = (store: Map<string, unknown>) => (store.get('data') as DotData).notes.map(n => n.text)

  test('a write waits while another session holds the lock, then lands', async ($, on) => {
    const { store, dirs, clock } = host(on, stored())
    dirs.set(LOCK, { mtimeMs: NOW, owner: 'other' })

    const writing = $.command.run(dot('note Prefers pnpm'))
    await clock.advance(200)
    expect(notes(store)).toEqual([])
    dirs.delete(LOCK)
    await clock.advance(200)
    await writing

    expect(notes(store)).toEqual(['Prefers pnpm'])
    expect(dirs.has(LOCK)).toBe(false)
  })

  test('a lock left by a session that died is broken', async ($, on) => {
    const { store, dirs } = host(on, stored())
    dirs.set(LOCK, { mtimeMs: NOW - 180_000, owner: 'dead' })

    await $.command.run(dot('note Prefers pnpm'))

    expect(notes(store)).toEqual(['Prefers pnpm'])
    expect([...dirs.keys()]).toEqual([])
  })

  test('a lock that changed hands while being broken is put back, not deleted', async ($, on) => {
    let isSwapped = false
    const { store, dirs, clock } = host(on, stored(), { onRun: (argv, d) => {
      if (argv[0] !== 'mv' || isSwapped) return
      isSwapped = true
      // Between our look and our move, the dead lock was cleared and a live session took it.
      d.set(LOCK, { mtimeMs: NOW, owner: 'live' })
    } })
    dirs.set(LOCK, { mtimeMs: NOW - 180_000, owner: 'dead' })

    const writing = $.command.run(dot('note Prefers pnpm'))
    await clock.advance(200)
    expect(dirs.get(LOCK)?.owner).toBe('live')
    expect(notes(store)).toEqual([])
    dirs.delete(LOCK)
    await clock.advance(200)
    await writing

    expect(notes(store)).toEqual(['Prefers pnpm'])
    expect([...dirs.keys()]).toEqual([])
  })

  test('a holder that lost its lock does not write', async ($, on) => {
    let reads = 0
    const { store, dirs } = host(on, stored(), {
      onGet: d => {
        reads += 1
        // The read inside the lock: another session takes the lock from under us.
        const lock = d.get(LOCK)
        if (lock !== undefined && reads > 1) lock.owner = 'thief'
      },
    })

    const said = await $.command.run(dot('note Prefers pnpm'))

    expect(said.text).toContain('lost the store lock')
    expect(notes(store)).toEqual([])
    expect(dirs.get(LOCK)?.owner).toBe('thief')
  })

  test('a holder whose lock was replaced puts the new owner’s lock back on release', async ($, on) => {
    let isReplaced = false
    const { store, dirs } = host(on, stored(), {
      onRun: (argv, d) => {
        // Between our ownership check and our release, another session broke our lock as stale and took it.
        const isRelease = (argv[0] === 'rm' || argv[0] === 'mv') && argv[1] === LOCK
        if (!isRelease || isReplaced) return
        isReplaced = true
        d.set(LOCK, { mtimeMs: NOW, owner: 'next' })
      },
    })

    await $.command.run(dot('note Prefers pnpm'))

    expect(notes(store)).toEqual(['Prefers pnpm'])
    expect(dirs.get(LOCK)?.owner).toBe('next')
    expect([...dirs.keys()]).toEqual([LOCK])
  })

  test('a lock whose owner file could not be written is not left behind', async ($, on) => {
    const { store, dirs } = host(on, stored(), { failOwnerWrite: true })

    const said = await $.command.run(dot('note Prefers pnpm'))

    expect(said.text).toContain('owner')
    expect(notes(store)).toEqual([])
    expect([...dirs.keys()]).toEqual([])
  })

  test('a holder that stalled past its lease does not write', async ($, on) => {
    let reads = 0
    const { store, dirs, clock } = host(on, stored(), {
      onGet: async () => {
        reads += 1
        // The read inside the lock stalls for over a minute: a breaker may judge the lock stale soon.
        if (reads === 2) await clock.set(NOW + 61_000)
      },
    })

    const said = await $.command.run(dot('note Prefers pnpm'))

    expect(said.text).toContain('held the store lock too long')
    expect(notes(store)).toEqual([])
    expect([...dirs.keys()]).toEqual([])
  })

  test('a lock that never frees fails loudly instead of writing', async ($, on) => {
    const { store, dirs, clock } = host(on, stored())
    dirs.set(LOCK, { mtimeMs: NOW, owner: 'other' })

    const writing = $.command.run(dot('note Prefers pnpm'))
    for (let second = 1; second <= 6; second += 1) {
      await clock.advance(1_000)
      dirs.set(LOCK, { mtimeMs: NOW + second * 1_000, owner: 'other' })
    }

    expect((await writing).text).toContain('store lock')
    expect(notes(store)).toEqual([])
  })

  test('a corrupt store is set aside under the lock', async ($, on) => {
    let wasLocked = false
    const { store } = host(on, stored(), {
      onSet: (key, d) => {
        if (key.startsWith('corrupt-')) wasLocked = d.has(LOCK)
      },
    })
    store.set('data', { version: 9 })

    await $.command.run(dot('list'))

    expect(wasLocked).toBe(true)
    expect([...store.keys()].some(key => key.startsWith('corrupt-'))).toBe(true)
  })

  test('setting aside a corrupt store is fenced like any write', async ($, on) => {
    const { store, dirs } = host(on, stored(), {
      onGet: d => {
        // Another session takes the lock from under us while we look at the unreadable value.
        const lock = d.get(LOCK)
        if (lock !== undefined) lock.owner = 'thief'
      },
    })
    store.set('data', { version: 9 })

    const said = await $.command.run(dot('note x'))

    expect(said.text).toContain('lost the store lock')
    expect(store.get('data')).toEqual({ version: 9 })
    expect([...store.keys()].some(key => key.startsWith('corrupt-'))).toBe(false)
    expect(dirs.get(LOCK)?.owner).toBe('thief')
  })

  test('the band shows what another session changed', async ($, on) => {
    const { store } = host(on, stored())
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    const band = await $.ui.mount({
      plugin: 'dot', surface: 'terminal', component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} },
    })
    expect(await band.find({ text: /Alfred/ })).toBeDefined()

    const data = store.get('data') as DotData
    store.set('data', { ...data, dot: data.dot && { ...data.dot, name: 'Jeeves' } })
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

    expect(await band.find({ text: /Jeeves/ })).toBeDefined()
    await band.unmount()
  })

  test('unrule leaves a rule another session tightened between the check and the write', async ($, on) => {
    let swap = (): void => {}
    const { store } = host(on, stored({ rules: [{ id: 'r1', level: 'allow', action: 'deploy' }] }), { onRun: () => swap() })
    swap = () => {
      store.set('data', { ...(store.get('data') as DotData), rules: [{ id: 'r1', level: 'handoff', action: 'deploy' }] })
      swap = () => {}
    }
    const out = (await $.tool.call({ tool: 'mcp__dot__unrule', rule: 1, action: 'deploy' } as never)) as { deny?: string }
    expect(out.deny).toContain('changed')
    expect((store.get('data') as DotData).rules).toEqual([{ id: 'r1', level: 'handoff', action: 'deploy' }])
  })

  test('the guard reads rules another session just added', async ($, on) => {
    const { store } = host(on, stored())
    on('tool.check', () => ({ decision: 'allow' }))
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'gh pr merge 3' } })).decision).toBe('allow')

    store.set('data', { ...(store.get('data') as DotData), rules: [rule('handoff', 'Bash(gh pr merge*)')] })

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'gh pr merge 3' } })).decision).toBe('deny')
  })
})

describe('the feed session', () => {
  const REPORT = (report: object) => `Done.\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``
  const running = (agentId: string) => ({
    id: 'a1', kind: 'work' as const, label: 'Check CI on main', cwd: 'C:/Dev/app', responsibilityId: null, agentId,
    sessionId: 's1', status: 'running' as const, startedAt: NOW, endedAt: null, summary: null,
  })

  /** What the host answers beneath the plugin when a session starts and an agent finishes. */
  function underneath(on: On) {
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 's1' }))
    on('command.register', () => ({ value: undefined }))
    on('tool.register', () => ({ value: undefined }))
    on('agent.register', () => ({ value: undefined }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    on('ui.toast', () => ({ value: undefined }))
    on('ui.notify', () => ({ value: undefined }))
    on('ui.log', () => ({ value: undefined }))
  }

  async function finish($: Parameters<Parameters<typeof test>[1]>[0], answer: string) {
    await $.session.start({ cwd: 'C:/Dev/app', surface: null, isInteractive: false })
    await $.turn.complete({ agentId: 'agent-1', answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    // The post is not awaited by the collector (it queues behind the running turn): let it reach the host.
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  /** A session that is (or is not) the feed, with one job running; returns what it posted into its conversation. */
  async function finishing(on: On, $: Parameters<Parameters<typeof test>[1]>[0], env: Record<string, string>, answer: string) {
    given(on, stored({ activity: [running('agent-1')] }), env)
    underneath(on)
    const posted: string[] = []
    on('prompt.submit', (_$, e) => {
      posted.push(e.text)
      return { text: e.text }
    })

    await finish($, answer)
    return posted
  }

  test('DOT_FEED=1 posts a result that needs the person into the conversation, once', async ($, on) => {
    const posted = await finishing(on, $, { DOT_FEED: '1' }, REPORT({ summary: 'deploy is blocked', needsYou: true, inbox: [{ kind: 'blocked', title: 'Deploy', body: 'needs a key' }] }))

    expect(posted).toHaveLength(1)
    expect(posted[0]).toContain('Alfred finished "Check CI on main": deploy is blocked')
    expect(posted[0]).toContain('- [blocked] Deploy: needs a key')
    expect(posted[0]).toContain('You are Alfred, and this was your own run')
  })

  test('DOT_FEED=1 posts a failed run', async ($, on) => {
    const posted = await finishing(on, $, { DOT_FEED: '1' }, 'no report here')

    expect(posted).toHaveLength(1)
    expect(posted[0]).toContain('Alfred\'s "Check CI on main" failed: could not report')
  })

  test('DOT_FEED=1 posts nothing for a routine run with nothing new', async ($, on) => {
    expect(await finishing(on, $, { DOT_FEED: '1' }, REPORT({ summary: 'all green' }))).toEqual([])
  })

  test('without DOT_FEED=1 nothing is posted, however much news', async ($, on) => {
    const news = REPORT({ summary: 'deploy is blocked', needsYou: true })

    expect(await finishing(on, $, {}, news)).toEqual([])
  })

  test('only the exact value 1 makes a feed', async ($, on) => {
    expect(await finishing(on, $, { DOT_FEED: 'true' }, REPORT({ summary: 'blocked', needsYou: true }))).toEqual([])
  })

  test('a post that is refused never breaks collecting the report', async ($, on) => {
    given(on, stored({ activity: [running('agent-1')] }), { DOT_FEED: '1' })
    underneath(on)
    on('prompt.submit', () => { throw new Error('busy') })

    await finish($, REPORT({ summary: 'blocked', needsYou: true }))

    expect((await $.command.run(dot('inbox'))).text).toContain('blocked')
  })

  /** An interactive session whose scheduler has one responsibility due; returns the jobs it started. */
  async function schedulerTick(on: On, $: Parameters<Parameters<typeof test>[1]>[0], other: Partial<DotData>) {
    const due = {
      id: 'r1', text: 'Check CI on main', schedule: { kind: 'interval' as const, minutes: 60 }, cwd: 'C:/Dev/app', createdAt: NOW,
      nextRunAt: NOW, lastRunAt: null, lastSummary: null, isPaused: false, check: null,
    }
    const clock = given(on, stored({ responsibilities: [due], ...other }))
    underneath(on)
    const started: string[] = []
    on('agent.spawn', (_$, e) => {
      started.push(e.description)
      return { agentId: `agent-${started.length}`, model: 'sonnet' }
    })

    await $.session.start({ cwd: 'C:/Dev/app', surface: null, isInteractive: true })
    await clock.advance(60_000)
    return started
  }

  test('a session that is not the feed leaves scheduled jobs to a live feed', async ($, on) => {
    const started = await schedulerTick(on, $, { heartbeats: { feed: NOW }, feedSessions: ['feed'] })

    expect(started).toEqual([])
  })

  test('with no live feed, scheduled jobs start as ever', async ($, on) => {
    expect(await schedulerTick(on, $, {})).toHaveLength(1)
  })

  test('a feed that stopped checking in no longer holds the jobs back', async ($, on) => {
    expect(await schedulerTick(on, $, { heartbeats: { feed: NOW - 10 * 60_000 }, feedSessions: ['feed'] })).toHaveLength(1)
  })
})

