import { describe, expect, test } from 'claude-code/testing'

import { feedMessage } from '../hooks/core/report'

const ASK = 'You are Alfred, and this was your own run: tell the person what you did in a sentence or two, in the first person, and say if they need to act. Do not act on it further unless they ask.'
const quiet = { name: 'Alfred', label: 'Check CI on main', summary: 'all green', isFailed: false, needsYou: false, inbox: [] }

describe('feedMessage', () => {
  test('a routine run with nothing new posts nothing', () => {
    expect(feedMessage(quiet)).toBeNull()
  })

  test('a failed run posts, worded as a failure', () => {
    const text = feedMessage({ ...quiet, isFailed: true, summary: 'could not report: no JSON' })

    expect(text?.split('\n')[0]).toBe('Alfred\'s "Check CI on main" failed: could not report: no JSON')
    expect(text?.split('\n').at(-1)).toBe(ASK)
  })

  test('a run that needs the person posts even with no inbox items', () => {
    const text = feedMessage({ ...quiet, needsYou: true, summary: 'deploy is blocked' })

    expect(text).toBe(`Alfred finished "Check CI on main": deploy is blocked\n${ASK}`)
  })

  test('inbox items post one line each, between the headline and the ask', () => {
    const text = feedMessage({
      ...quiet,
      inbox: [
        { kind: 'question', title: 'Revert #41?', body: 'It broke login.' },
        { kind: 'result', title: 'Build', body: 'passed' },
      ],
    })

    expect(text?.split('\n')).toEqual([
      'Alfred finished "Check CI on main": all green',
      '- [question] Revert #41?: It broke login.',
      '- [result] Build: passed',
      ASK,
    ])
  })
})
