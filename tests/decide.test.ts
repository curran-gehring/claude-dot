import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_LOOK } from '../hooks/core/avatar'
import { emptyData } from '../hooks/core/data'
import { afterReview, decide } from '../hooks/core/decide'
import type { Call } from '../hooks/core/decide'
import type { DotData, DotRule } from '../types'

const dot = (change: Partial<DotData> = {}): DotData => ({ ...emptyData(), dot: { name: 'Alfred', look: DEFAULT_LOOK, createdAt: 0 }, ...change })
const rule = (level: DotRule['level'], action: string): DotRule => ({ id: action, level, action })
const call = (change: Partial<Call>): Call => ({ tool: 'Bash', input: { command: 'ls' }, isResearch: false, isCall: true, cwd: 'C:/Dev/app', base: { decision: 'allow' }, ...change })
const push = { tool: 'Bash', input: { command: 'git push origin main' } }
describe('decide', () => {
  test('a consequential real call goes to Auto-review', async () => {
    expect(decide(dot(), call(push))).toEqual({ kind: 'review', rule: undefined })
  })

  test('a query is never reviewed', async () => {
    expect(decide(dot(), call({ ...push, isCall: false }))).toEqual({ kind: 'answer', check: { decision: 'allow' } })
  })

  test('reading is never reviewed', async () => {
    expect(decide(dot(), call({ tool: 'Bash', input: { command: 'git status' } }))).toEqual({ kind: 'answer', check: { decision: 'allow' } })
  })

  test('with Auto-review off, the engine decides', async () => {
    const off = dot({ settings: { ...emptyData().settings, isAutoReview: false } })
    expect(decide(off, call(push))).toEqual({ kind: 'answer', check: { decision: 'allow' } })
  })

  test('a handoff rule on a real call refuses and files it', async () => {
    expect(decide(dot({ rules: [rule('handoff', 'Bash(git push*)')] }), call(push))).toEqual(expect.objectContaining({ kind: 'report', inbox: 'handoff' }))
  })

  test('an ask rule on a real call goes to the person', async () => {
    expect(decide(dot({ rules: [rule('ask', 'Bash(git push*)')] }), call(push))).toEqual({ kind: 'ask', why: expect.stringContaining('ask first') })
  })

  test('a when-asked rule is reviewed even on a plain call', async () => {
    expect(decide(dot({ rules: [rule('when-asked', 'Bash(pnpm*)')] }), call({ input: { command: 'pnpm install' } }))).toEqual({ kind: 'review', rule: rule('when-asked', 'Bash(pnpm*)') })
  })

  test('research may only read', async () => {
    expect(decide(dot(), call({ tool: 'Edit', input: { file_path: 'C:/Dev/app/a.ts' }, isResearch: true }))).toEqual({ kind: 'answer', check: expect.objectContaining({ decision: 'deny' }) })
    expect(decide(dot(), call({ tool: 'Read', input: { file_path: 'C:/Dev/app/a.ts' }, isResearch: true }))).toEqual({ kind: 'answer', check: { decision: 'allow' } })
  })
})

describe('afterReview', () => {
  const base = { decision: 'ask' as const }

  test('run keeps the engine’s own decision, or allows what a rule allows', async () => {
    expect(afterReview({ verdict: 'run', reason: 'asked' }, undefined, base)).toEqual({ kind: 'answer', check: base })
    expect(afterReview({ verdict: 'run', reason: 'asked' }, rule('when-asked', 'Bash(x)'), base)).toEqual({ kind: 'answer', check: { decision: 'allow', reason: 'Auto-review: asked' } })
  })

  test('ask goes to the person; handoff and block refuse and file it', async () => {
    expect(afterReview({ verdict: 'ask', reason: 'unclear' }, undefined, base)).toEqual({ kind: 'ask', why: 'Auto-review: unclear' })
    expect(afterReview({ verdict: 'handoff', reason: 'money' }, undefined, base)).toEqual(expect.objectContaining({ kind: 'report', inbox: 'handoff' }))
    expect(afterReview({ verdict: 'block', reason: 'nobody asked to push' }, undefined, base)).toEqual({
      kind: 'report', inbox: 'blocked', body: 'Auto-review: nobody asked to push',
      check: { decision: 'deny', reason: 'Auto-review blocked this: nobody asked to push' },
    })
  })
})
