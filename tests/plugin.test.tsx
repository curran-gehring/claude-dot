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
function given(on: On, data: DotData | undefined) {
  mock.clock(on, { now: NOW })
  mock.store(on, data === undefined ? {} : { data })
  on('session.cwd', () => ({ value: 'C:/Dev/app' }))
  on('env.get', (_$, e) => ({ value: ({ HOME: '/home/me', USERNAME: 'Curran' } as Record<string, string>)[e.name] }))
  // The store lock is always free here; the sharing tests below hold it.
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
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

describe('the band', () => {
  const BAND = {
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  } as const

  test('shows the dot, what it watches and what needs you', async ($, on) => {
    const inbox = [{ id: 'i1', at: NOW, kind: 'question', title: 'Revert #41?', body: 'b', isDone: false }] as const
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
      nextRunAt: NOW + 60_000 * 60, lastRunAt: null, lastSummary: 'all green', isPaused: false,
    }],
    rules: [rule('handoff', 'Bash(gh pr merge*)')],
    notes: [{ id: 'n1', at: NOW, text: 'Prefers pnpm', source: 'you' }],
    inbox: [{ id: 'i1', at: NOW, kind: 'question', title: 'Revert #41?', body: 'It broke login.', isDone: false }],
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
  /**
   * The host beneath the plugin: an in-memory store and the lock directory
   * `mkdir` claims atomically, so a test can hold or orphan the lock.
   */
  function host(on: On, initial: DotData) {
    const store = new Map<string, unknown>([['data', initial]])
    const lock = { isHeld: false, mtimeMs: 0, makes: 0 }
    on('store.get', (_$, e) => ({ value: structuredClone(store.get(e.key)) }))
    on('store.set', (_$, e) => {
      if (!lock.isHeld) throw new Error('a write outside the lock')
      store.set(e.key, structuredClone(e.value))
      return { value: undefined }
    })
    on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
    on('process.run', (_$, e) => {
      const verb = e.argv[0]
      const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      if (verb === 'mkdir') {
        if (lock.isHeld) return { value: { ...ok, exitCode: 1, stderr: 'File exists' } }
        lock.isHeld = true
        lock.makes += 1
        lock.mtimeMs = NOW
        return { value: ok }
      }
      if (verb === 'rmdir') {
        lock.isHeld = false
        return { value: ok }
      }
      throw new Error(`unexpected command ${e.argv.join(' ')}`)
    })
    on('fs.stat', (_$, e) => {
      if (!lock.isHeld) throw new Error(`no such file: ${e.path}`)
      return { value: { kind: 'dir', size: 0, mtimeMs: lock.mtimeMs, isLink: false } }
    })
    on('session.cwd', () => ({ value: 'C:/Dev/app' }))
    return { store, lock, clock: mock.clock(on, { now: NOW }) }
  }

  test('a write waits while another session holds the lock, then lands', async ($, on) => {
    const { store, lock, clock } = host(on, stored())
    lock.isHeld = true
    lock.mtimeMs = NOW

    const writing = $.command.run(dot('note Prefers pnpm'))
    await clock.advance(200)
    expect((store.get('data') as DotData).notes).toEqual([])
    lock.isHeld = false
    await clock.advance(200)
    await writing

    expect((store.get('data') as DotData).notes.map(n => n.text)).toEqual(['Prefers pnpm'])
    expect(lock.isHeld).toBe(false)
  })

  test('a lock left by a session that died is broken', async ($, on) => {
    const { store, lock } = host(on, stored())
    lock.isHeld = true
    lock.mtimeMs = NOW - 60_000

    await $.command.run(dot('note Prefers pnpm'))

    expect((store.get('data') as DotData).notes.map(n => n.text)).toEqual(['Prefers pnpm'])
  })

  test('a lock that never frees fails loudly instead of writing', async ($, on) => {
    const { store, lock, clock } = host(on, stored())
    lock.isHeld = true
    lock.mtimeMs = NOW

    const writing = $.command.run(dot('note Prefers pnpm'))
    await clock.advance(1_000)
    lock.mtimeMs = NOW + 1_000
    await clock.advance(1_000)
    lock.mtimeMs = NOW + 2_000
    await clock.advance(4_000)

    expect((await writing).text).toContain('store lock')
    expect((store.get('data') as DotData).notes).toEqual([])
  })

  test('the guard reads rules another session just added', async ($, on) => {
    const { store } = host(on, stored())
    on('tool.check', () => ({ decision: 'allow' }))
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'gh pr merge 3' } })).decision).toBe('allow')

    store.set('data', { ...(store.get('data') as DotData), rules: [rule('handoff', 'Bash(gh pr merge*)')] })

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'gh pr merge 3' } })).decision).toBe('deny')
  })
})
