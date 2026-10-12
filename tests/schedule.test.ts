import { describe, expect, test } from 'claude-code/testing'

import { describeSchedule, nextRunAt, parseSchedule } from '../hooks/core/schedule'
import type { DotSchedule } from '../types'

const MIN = 60_000
// Monday 2026-10-12 00:00 UTC
const MONDAY = Date.UTC(2026, 9, 12)
const UTC = () => 0

describe('parseSchedule', () => {
  test('intervals', async () => {
    expect(parseSchedule('every 30m')).toEqual({ kind: 'interval', minutes: 30 })
    expect(parseSchedule('every 2h')).toEqual({ kind: 'interval', minutes: 120 })
    expect(parseSchedule('Every 1 day')).toEqual({ kind: 'interval', minutes: 1440 })
    expect(parseSchedule('hourly')).toEqual({ kind: 'interval', minutes: 60 })
  })

  test('times of day', async () => {
    expect(parseSchedule('daily 9:00')).toEqual({ kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], minute: 540 })
    expect(parseSchedule('weekdays 09:30')).toEqual({ kind: 'weekly', days: [1, 2, 3, 4, 5], minute: 570 })
    expect(parseSchedule('mon,wed,fri 17:00')).toEqual({ kind: 'weekly', days: [1, 3, 5], minute: 1020 })
    expect(parseSchedule('weekends 8am')).toEqual({ kind: 'weekly', days: [0, 6], minute: 480 })
    expect(parseSchedule('daily 5:15pm')).toEqual({ kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], minute: 1035 })
  })

  test('rejects what it cannot read, loudly', async () => {
    expect(parseSchedule('whenever')).toEqual({ error: expect.stringContaining('whenever') })
    expect(parseSchedule('every 0m')).toEqual({ error: expect.stringContaining('every 0m') })
    expect(parseSchedule('daily 25:00')).toEqual({ error: expect.stringContaining('25:00') })
    expect(parseSchedule('every 999999999999999999999999h')).toEqual({ error: expect.stringContaining('a year') })
    expect(parseSchedule('every 400d')).toEqual({ error: expect.stringContaining('a year') })
    expect(parseSchedule('every 365d')).toEqual({ kind: 'interval', minutes: 365 * 1440 })
  })
})

describe('nextRunAt', () => {
  test('a time of day keeps its local time across a DST change', async () => {
    // US Eastern falls back at 2026-11-01 06:00 UTC: -240 before, -300 after.
    const FALL_BACK = Date.UTC(2026, 10, 1, 6)
    const eastern = (at: number) => (at < FALL_BACK ? -240 : -300)
    const daily9: DotSchedule = { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], minute: 540 }
    // Saturday 10:00 EDT (14:00 UTC): the next 09:00 is Sunday 09:00 EST, 14:00 UTC.
    expect(nextRunAt(daily9, Date.UTC(2026, 9, 31, 14), eastern)).toBe(Date.UTC(2026, 10, 1, 14))
    // Sunday 01:00 EDT (05:00 UTC), an hour before the change: still Sunday 09:00 EST.
    expect(nextRunAt(daily9, Date.UTC(2026, 10, 1, 5), eastern)).toBe(Date.UTC(2026, 10, 1, 14))
    // Sunday 08:00 EST (13:00 UTC), after the change: Sunday 09:00 EST, not an hour early.
    expect(nextRunAt(daily9, Date.UTC(2026, 10, 1, 13), eastern)).toBe(Date.UTC(2026, 10, 1, 14))
    // Saturday 08:00 EDT (12:00 UTC): Saturday 09:00 EDT is 13:00 UTC.
    expect(nextRunAt(daily9, Date.UTC(2026, 9, 31, 12), eastern)).toBe(Date.UTC(2026, 9, 31, 13))
  })

  test('a time of day keeps its local time across spring forward', async () => {
    // US Eastern springs forward at 2026-03-08 07:00 UTC: -300 before, -240 after.
    const SPRING = Date.UTC(2026, 2, 8, 7)
    const eastern = (at: number) => (at < SPRING ? -300 : -240)
    const daily9: DotSchedule = { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], minute: 540 }
    // Saturday 10:00 EST (15:00 UTC): Sunday 09:00 EDT is 13:00 UTC.
    expect(nextRunAt(daily9, Date.UTC(2026, 2, 7, 15), eastern)).toBe(Date.UTC(2026, 2, 8, 13))
  })

  test('an interval runs that long after now', async () => {
    expect(nextRunAt({ kind: 'interval', minutes: 30 }, MONDAY, UTC)).toBe(MONDAY + 30 * MIN)
  })

  test('a time of day runs at the next matching local minute', async () => {
    const daily9: DotSchedule = { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], minute: 540 }
    expect(nextRunAt(daily9, MONDAY + 8 * 60 * MIN, UTC)).toBe(MONDAY + 9 * 60 * MIN)
    expect(nextRunAt(daily9, MONDAY + 10 * 60 * MIN, UTC)).toBe(MONDAY + (24 + 9) * 60 * MIN)
    expect(nextRunAt(daily9, MONDAY + 9 * 60 * MIN, UTC)).toBe(MONDAY + (24 + 9) * 60 * MIN)
  })

  test('weekdays skip the weekend', async () => {
    const weekdays9: DotSchedule = { kind: 'weekly', days: [1, 2, 3, 4, 5], minute: 540 }
    const fridayNoon = MONDAY + (4 * 24 + 12) * 60 * MIN
    expect(nextRunAt(weekdays9, fridayNoon, UTC)).toBe(MONDAY + (7 * 24 + 9) * 60 * MIN)
  })

  test('local time is honoured through the offset', async () => {
    const daily9: DotSchedule = { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], minute: 540 }
    // UTC-5: 09:00 local is 14:00 UTC
    expect(nextRunAt(daily9, MONDAY, () => -300)).toBe(MONDAY + 14 * 60 * MIN)
  })
})

test('describeSchedule reads back as written', async () => {
  expect(describeSchedule(null)).toBe('when the dot decides')
  expect(describeSchedule({ kind: 'interval', minutes: 90 })).toBe('every 1h 30m')
  expect(describeSchedule({ kind: 'weekly', days: [1, 2, 3, 4, 5], minute: 570 })).toBe('weekdays 09:30')
  expect(describeSchedule({ kind: 'weekly', days: [1, 3], minute: 1020 })).toBe('mon,wed 17:00')
})
