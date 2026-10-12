import type { DotRule, DotRuleLevel } from '../../types'

/** A rule's action as a tool pattern: `Bash(git push*)`, `Edit`, `mcp__*__send*`. */
export type ActionPattern = { tool: string; arg: string | null }

const STRICTNESS: Record<DotRuleLevel, number> = { allow: 0, 'when-asked': 1, ask: 2, handoff: 3 }
const SHELLS = new Set(['Bash', 'PowerShell'])
const FILE_WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const OWN_TOOLS = 'mcp__dot__'

/**
 * A rule's action is a tool pattern when it reads as one (a tool name, glob
 * stars allowed, then an optional `(argument glob)`); anything else is a
 * description in words, which only Auto-review reads.
 */
export function parseAction(action: string): ActionPattern | null {
  const found = /^([A-Za-z][\w*-]*)(?:\((.*)\))?$/.exec(action.trim())
  if (!found) return null
  const tool = found[1] ?? ''
  const isToolName = /^[A-Z]/.test(tool) || tool.startsWith('mcp__')

  return isToolName ? { tool, arg: found[2] ?? null } : null
}

/** The strictest rule whose pattern matches the call, if any. */
export function matchingRule(rules: readonly DotRule[], tool: string, input: unknown): DotRule | undefined {
  let found: DotRule | undefined
  for (const rule of rules) {
    const pattern = parseAction(rule.action)
    if (pattern === null || !matches(pattern, tool, input)) continue
    if (found === undefined || STRICTNESS[rule.level] > STRICTNESS[found.level]) found = rule
  }

  return found
}

function matches(pattern: ActionPattern, tool: string, input: unknown): boolean {
  if (!globOf(pattern.tool).test(tool)) return false

  return pattern.arg === null || globOf(pattern.arg).test(argOf(tool, input))
}

/** The argument a pattern's parentheses are matched against. */
export function argOf(tool: string, input: unknown): string {
  const fields = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  if (SHELLS.has(tool) && typeof fields.command === 'string') return fields.command
  if (typeof fields.file_path === 'string') return slashes(fields.file_path)
  if (typeof fields.notebook_path === 'string') return slashes(fields.notebook_path)
  if (typeof fields.url === 'string') return fields.url

  return JSON.stringify(fields)
}

function globOf(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')

  return new RegExp(`^${body}$`, 'is')
}

const RISKY_SHELL = [
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b[^;&|]*\s-[a-z]*f/i,
  /\bgit\s+branch\s+-D\b/,
  /(^|[;&|(]\s*|\s)(rm|rmdir|del|erase|rd)\s/i,
  /\bRemove-Item\b/i,
  /\bgh\s+(pr\s+(merge|close)|release\s+(create|delete|upload)|repo\s+(delete|archive|create|rename)|secret|issue\s+(close|delete)|workflow\s+run)\b/i,
  /\bgh\s+api\b.*(-X|--method)\s*(POST|PUT|PATCH|DELETE)\b/i,
  /\b(npm|pnpm|yarn|cargo)\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b/i,
  /\bcurl\b.*(\s-X\s*(POST|PUT|PATCH|DELETE)\b|\s--request\s+(POST|PUT|PATCH|DELETE)\b|\s(-d|--data[\w-]*|-F|--form)\s)/i,
  /\bInvoke-(RestMethod|WebRequest)\b.*-Method\s+(Post|Put|Patch|Delete)\b/i,
  /\b(drop|truncate)\s+(table|database|schema)\b|\bdelete\s+from\b|\bupdate\s+\w+\s+set\b/i,
  /\b(terraform|pulumi)\s+(apply|destroy|up)\b|\bkubectl\s+(apply|delete|scale|rollout)\b|\bdocker\s+(push|rm|rmi|system\s+prune)\b/i,
  /\b(wrangler|vercel|netlify|fly|firebase)\s+(deploy|publish|--prod)\b/i,
  /(^|[;&|]\s*)(ssh|scp|rsync)\s/i,
  /\b(sudo|shutdown|reboot|mkfs)\b|\bdd\s+if=|\bformat\s+[a-z]:/i,
  /\b(chmod|chown)\s+-R\b/i,
  /\b(Stop-Process|taskkill|Stop-Service|Restart-Service)\b|\bkill\s+-9\b|\bsc(\.exe)?\s+(stop|delete)\b|\bnssm\s+(stop|remove|restart)\b/i,
]

const SECRET_PATH = /(^|\/)\.env(\.|$)|(^|\/)\.ssh\/|id_rsa|id_ed25519|credentials|(^|\/)secrets?\.(json|ya?ml|env|toml)$|\.pem$|\.key$/i

/** Words in a connector tool's name that say it only reads. */
const READ_VERBS = new Set([
  'get', 'list', 'search', 'read', 'fetch', 'find', 'describe', 'view', 'show', 'inspect', 'lookup',
  'count', 'preview', 'render', 'screenshot', 'whoami', 'info', 'stat', 'status', 'help', 'details',
])

/** Words that say it changes something, whatever else the name says. */
const WRITE_VERBS = new Set([
  'send', 'post', 'publish', 'delete', 'trash', 'remove', 'create', 'update', 'merge', 'transfer', 'pay', 'share',
  'forward', 'reply', 'invite', 'upload', 'archive', 'unarchive', 'spam', 'respond', 'execute', 'drop', 'cancel',
  'fire', 'grant', 'revoke', 'deploy', 'purchase', 'buy', 'refund', 'charge', 'sign', 'apply', 'write', 'set',
  'move', 'edit', 'rename', 'insert', 'put', 'patch', 'add', 'modify', 'save', 'run', 'query',
])

/**
 * Whether a call could change something outside the conversation that is
 * hard to take back: what Auto-review looks at before it runs. Reads,
 * searches and edits inside the project are not.
 */
export function isConsequential(tool: string, input: unknown, cwd: string): boolean {
  if (tool.startsWith(OWN_TOOLS)) return false
  if (SHELLS.has(tool)) {
    const command = argOf(tool, input)
    return RISKY_SHELL.some(risk => risk.test(command))
  }
  if (FILE_WRITERS.has(tool)) {
    const path = argOf(tool, input)
    return SECRET_PATH.test(path) || !isInside(path, cwd)
  }
  if (tool.startsWith('mcp__')) {
    // Unknown is reviewed: a connector tool passes only when its name reads and never writes.
    const words = (tool.split('__').pop() ?? '').toLowerCase().split(/[_-]/)
    return words.some(word => WRITE_VERBS.has(word)) || !words.some(word => READ_VERBS.has(word))
  }

  return false
}

/** Whether `path` lies under `dir` once `.` and `..` are resolved; a relative path never does. */
function isInside(path: string, dir: string): boolean {
  const root = resolved(dir)
  const target = resolved(path)

  return root !== null && target !== null && target.startsWith(`${root}/`)
}

/** An absolute path with `.` and `..` resolved, lowercased; null when relative or climbing above its root. */
function resolved(path: string): string | null {
  const [head = '', ...rest] = slashes(path).toLowerCase().split('/')
  const isAbsolute = head === '' || /^[a-z]:$/.test(head)
  if (!isAbsolute) return null
  const parts: string[] = []
  for (const part of rest) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.pop() === undefined) return null
      continue
    }
    parts.push(part)
  }

  return [head, ...parts].join('/')
}

function slashes(path: string): string {
  return path.replace(/\\/g, '/')
}
