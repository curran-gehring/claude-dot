import type { DotData, DotRule } from '../../types'
import type { Review } from './review'
import { isConsequential, matchingRule } from './rules'

export type Check = { decision: 'allow' | 'ask' | 'deny'; reason?: string }

/** The next step of the guard for one call. */
export type Step =
  /** Answer the engine with this. */
  | { kind: 'answer'; check: Check }
  /** Put it to the person, saying why. */
  | { kind: 'ask'; why: string }
  /** Answer, and file an inbox item about it. */
  | { kind: 'report'; check: Check; inbox: 'handoff' | 'blocked'; body: string }
  /** Have Auto-review read it first, then call `afterReview`. */
  | { kind: 'review'; rule: DotRule | undefined }

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch', 'TodoWrite'])

export type Call = {
  tool: string
  input: unknown
  /** The call comes from the dot's research agent, which may only read. */
  isResearch: boolean
  /** A real call (not a `$.tool.check` query): only real calls are reviewed, asked or reported. */
  isCall: boolean
  cwd: string
  /** What the engine decided on its own (the person's settings and mode). */
  base: Check
}

/**
 * Decides a call before Auto-review: the dot's own tools pass, the person's
 * own deny always stands, research only reads, rules apply strictest first,
 * and only consequential calls (or `when-asked` ones) go to review.
 */
export function decide(data: DotData, call: Call): Step {
  const name = data.dot?.name ?? 'Your dot'
  const answer = (check: Check): Step => ({ kind: 'answer', check })
  if (call.base.decision === 'deny') return answer(call.base)
  if (call.isResearch && !READ_ONLY_TOOLS.has(call.tool)) {
    return answer({ decision: 'deny', reason: `${name}'s proactive research can only read; ${call.tool} is refused there.` })
  }

  const rule = matchingRule(data.rules, call.tool, call.input)
  if (rule?.level === 'handoff') {
    const check: Check = { decision: 'deny', reason: `Hand off to the person: their rule "${rule.action}" says they do this themselves. Tell them exactly what to run or do instead.` }
    return call.isCall ? { kind: 'report', check, inbox: 'handoff', body: `Your rule "${rule.action}" says you do this yourself.` } : answer(check)
  }
  if (rule?.level === 'ask') {
    return call.isCall ? { kind: 'ask', why: `Your rule "${rule.action}" says ask first` } : answer({ decision: 'ask', reason: `${name}: rule "${rule.action}"` })
  }

  const allowed: Check = { decision: 'allow', reason: `${name}: rule "${rule?.action}"` }
  const isReviewed = isConsequential(call.tool, call.input, call.cwd) || rule?.level === 'when-asked'
  if (!isReviewed) return answer(rule?.level === 'allow' ? allowed : call.base)
  if (!call.isCall) return answer(call.base)
  if (!data.settings.isAutoReview || data.dot === null) {
    if (rule?.level === 'when-asked') return { kind: 'ask', why: `Your rule "${rule.action}" says only when you ask` }
    return answer(rule?.level === 'allow' ? allowed : call.base)
  }

  return { kind: 'review', rule }
}

/** What Auto-review's verdict means for the call. */
export function afterReview(review: Review, rule: DotRule | undefined, base: Check): Step {
  switch (review.verdict) {
    case 'run':
      return { kind: 'answer', check: rule ? { decision: 'allow', reason: `Auto-review: ${review.reason}` } : base }
    case 'ask':
      return { kind: 'ask', why: `Auto-review: ${review.reason}` }
    case 'handoff':
      return {
        kind: 'report',
        inbox: 'handoff',
        body: `Auto-review: ${review.reason}`,
        check: { decision: 'deny', reason: `Auto-review handed this to the person: ${review.reason}. Tell them exactly what to run or do instead.` },
      }
    case 'block':
      return {
        kind: 'report',
        inbox: 'blocked',
        body: `Auto-review: ${review.reason}`,
        check: { decision: 'deny', reason: `Auto-review blocked this: ${review.reason}` },
      }
  }
}
