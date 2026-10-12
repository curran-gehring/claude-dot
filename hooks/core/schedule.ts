import type { DotSchedule } from '../../types'

const MIN = 60_000
const DAY_MIN = 24 * 60
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
const WEEKDAYS = [1, 2, 3, 4, 5]
const WEEKENDS = [0, 6]
const UNIT_MINUTES: Record<string, number> = { m: 1, min: 1, mins: 1, minute: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, d: DAY_MIN, day: DAY_MIN, days: DAY_MIN }

/**
 * Reads the schedule grammar: `every 30m`, `every 2h`, `hourly`,
 * `daily 9:00`, `weekdays 09:30`, `weekends 8am`, `mon,wed,fri 17:00`.
 */
export function parseSchedule(text: string): DotSchedule | { error: string } {
  const said = text.trim().toLowerCase()
  const refuse = { error: `"${text.trim()}" is not a schedule (try "every 2h", "daily 9:00", "weekdays 9:30", "mon,thu 17:00")` }

  if (said === 'hourly') return { kind: 'interval', minutes: 60 }

  const every = /^every\s+(\d+)\s*([a-z]+)$/.exec(said)
  if (every) {
    const per = UNIT_MINUTES[every[2] ?? '']
    const count = Number(every[1])
    return per !== undefined && count > 0 ? { kind: 'interval', minutes: count * per } : refuse
  }

  const timed = /^([a-z,]+)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(said)
  if (!timed) return refuse
  const days = daysOf(timed[1] ?? '')
  const minute = minuteOf(Number(timed[2]), Number(timed[3] ?? 0), timed[4])
  if (days === null) return refuse
  if (minute === null) return { error: `${timed[2]}:${timed[3] ?? '00'} is not a time of day` }

  return { kind: 'weekly', days, minute }
}

function daysOf(word: string): number[] | null {
  if (word === 'daily' || word === 'everyday') return ALL_DAYS
  if (word === 'weekdays') return WEEKDAYS
  if (word === 'weekends') return WEEKENDS
  const days = word.split(',').map(day => DAY_NAMES.indexOf(day.slice(0, 3)))

  return days.length > 0 && days.every(day => day >= 0) ? [...new Set(days)].sort() : null
}

function minuteOf(hour: number, minute: number, half: string | undefined): number | null {
  if (minute > 59) return null
  if (half === undefined) return hour <= 23 ? hour * 60 + minute : null
  if (hour < 1 || hour > 12) return null

  return ((hour % 12) + (half === 'pm' ? 12 : 0)) * 60 + minute
}

/**
 * When a schedule next runs after `now`, strictly later. `offsetMinutes` is
 * local time minus UTC (UTC-5 is -300), so `09:00` means the person's 09:00.
 */
export function nextRunAt(schedule: DotSchedule, now: number, offsetMinutes: number): number {
  if (schedule.kind === 'interval') return now + schedule.minutes * MIN

  const local = now + offsetMinutes * MIN
  const midnight = Math.floor(local / (DAY_MIN * MIN)) * DAY_MIN * MIN
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const day = midnight + ahead * DAY_MIN * MIN
    const at = day + schedule.minute * MIN
    if (at > local && schedule.days.includes(new Date(day).getUTCDay())) {
      return at - offsetMinutes * MIN
    }
  }
  throw new Error(`schedule has no day to run on: ${JSON.stringify(schedule)}`)
}

export function describeSchedule(schedule: DotSchedule | null): string {
  if (schedule === null) return 'when the dot decides'
  if (schedule.kind === 'interval') return `every ${durationOf(schedule.minutes)}`

  const days = sameDays(schedule.days, ALL_DAYS)
    ? 'daily'
    : sameDays(schedule.days, WEEKDAYS)
      ? 'weekdays'
      : sameDays(schedule.days, WEEKENDS)
        ? 'weekends'
        : schedule.days.map(day => DAY_NAMES[day]).join(',')

  return `${days} ${clockOf(schedule.minute)}`
}

export function clockOf(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

function durationOf(minutes: number): string {
  const days = Math.floor(minutes / DAY_MIN)
  const hours = Math.floor((minutes % DAY_MIN) / 60)
  const rest = minutes % 60

  return [days ? `${days}d` : '', hours ? `${hours}h` : '', rest ? `${rest}m` : ''].filter(Boolean).join(' ')
}

function sameDays(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((day, at) => day === b[at])
}
