import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_LOOK, face, handleFor, moodOf } from '../hooks/core/avatar'
import { emptyData } from '../hooks/core/data'

describe('face', () => {
  test('the default dot', async () => {
    expect(face(DEFAULT_LOOK, 'idle')).toBe('(•ᴗ•)')
  })

  test('the look changes the face', async () => {
    expect(face({ ...DEFAULT_LOOK, shape: 'square', eyes: 'happy', accessory: 'crown' }, 'idle')).toBe('♛[^ᴗ^]')
    expect(face({ ...DEFAULT_LOOK, glasses: 'round' }, 'idle')).toBe('((•)ᴗ(•))')
    expect(face({ ...DEFAULT_LOOK, glasses: 'shades' }, 'idle')).toBe('(■ᴗ■)')
  })

  test('the mood changes the face', async () => {
    expect(face(DEFAULT_LOOK, 'working')).toBe('(•_•)')
    expect(face(DEFAULT_LOOK, 'needs-you')).toBe('(•o•)!')
    expect(face(DEFAULT_LOOK, 'asleep')).toBe('(-‿-)ᶻ')
  })
})

test('handleFor', async () => {
  expect(handleFor('Curran', 'Alfred')).toBe('@curran-alfred')
  expect(handleFor(undefined, 'Pink Princess')).toBe('@you-pink-princess')
})

describe('moodOf', () => {
  const base = emptyData()
  const item = { id: 'i', at: 0, kind: 'question', title: 't', body: 'b', isUrgent: false, isDone: false } as const
  const running = {
    id: 'a', kind: 'work', label: 'l', cwd: '.', responsibilityId: null, agentId: 'x', sessionId: 's',
    status: 'running', startedAt: 0, endedAt: null, summary: null,
  } as const

  test('asleep beats everything, then what needs you, then work', async () => {
    expect(moodOf(base)).toBe('idle')
    expect(moodOf({ ...base, activity: [running] })).toBe('working')
    expect(moodOf({ ...base, activity: [running], inbox: [item] })).toBe('needs-you')
    expect(moodOf({ ...base, inbox: [item], settings: { ...base.settings, isAsleep: true } })).toBe('asleep')
  })

  test('a done item needs nobody', async () => {
    expect(moodOf({ ...base, inbox: [{ ...item, isDone: true }] })).toBe('idle')
  })
})
