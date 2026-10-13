export type DotShape = 'round' | 'square' | 'soft' | 'pointy' | 'bubble'
export type DotEyes = 'dots' | 'beady' | 'round' | 'wide' | 'happy' | 'star' | 'sparkle' | 'heart'
export type DotGlasses = 'none' | 'round' | 'square' | 'shades' | 'monocle'
export type DotAccessory = 'none' | 'crown' | 'flower' | 'bolt' | 'star' | 'leaf' | 'heart'
export type DotColor = 'teal' | 'blue' | 'purple' | 'pink' | 'orange' | 'yellow' | 'green' | 'red' | 'gray'
export type DotMood = 'idle' | 'working' | 'needs-you' | 'asleep'

export type DotLook = {
  shape: DotShape
  eyes: DotEyes
  glasses: DotGlasses
  accessory: DotAccessory
  color: DotColor
}

export type DotIdentity = { name: string; look: DotLook; createdAt: number }

/** When a responsibility runs; `null` on a responsibility leaves it to the dot. */
export type DotSchedule =
  | { kind: 'interval'; minutes: number }
  /** `days` are 0 (Sunday) to 6; `minute` is minutes after local midnight. */
  | { kind: 'weekly'; days: number[]; minute: number }

export type DotResponsibility = {
  id: string
  text: string
  schedule: DotSchedule | null
  cwd: string
  createdAt: number
  nextRunAt: number | null
  lastRunAt: number | null
  lastSummary: string | null
  isPaused: boolean
  /** A shell command run before each automatic run; the agent starts only when it exits 0. */
  check: string | null
}

export type DotRuleLevel = 'allow' | 'when-asked' | 'ask' | 'handoff'
export type DotRule = { id: string; level: DotRuleLevel; action: string }

export type DotNote = { id: string; at: number; text: string; source: 'you' | 'research' | 'work' }

export type DotInboxKind = 'question' | 'suggestion' | 'result' | 'handoff' | 'blocked'
export type DotInboxItem = {
  id: string
  at: number
  kind: DotInboxKind
  title: string
  body: string
  /** The report that filed it said the person must look soon. */
  isUrgent: boolean
  isDone: boolean
}

export type DotActivityKind = 'work' | 'research' | 'delegate'
export type DotActivity = {
  id: string
  kind: DotActivityKind
  label: string
  cwd: string
  responsibilityId: string | null
  agentId: string | null
  /** The Claude Code session that started it; its heartbeat says whether it can still finish. */
  sessionId: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt: number | null
  summary: string | null
}

export type DotSettings = { isAsleep: boolean; isAutoReview: boolean; isBandShown: boolean }

export type DotData = {
  version: 1
  dot: DotIdentity | null
  responsibilities: DotResponsibility[]
  rules: DotRule[]
  notes: DotNote[]
  inbox: DotInboxItem[]
  activity: DotActivity[]
  settings: DotSettings
  /** Last proactive research pass per project directory. */
  lastResearchAt: Record<string, number>
  /** Last time each open Claude Code session checked in, by session id. */
  heartbeats: Record<string, number>
  /** The sessions started with DOT_FEED=1; while one is alive (see heartbeats), only it starts scheduled jobs. */
  feedSessions: string[]
}

declare module 'claude-code' {
  interface PluginState {
    dot: { data: DotData | null; draft: DotIdentity | null }
  }
}
