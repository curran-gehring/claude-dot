import type {
  DotAccessory,
  DotColor,
  DotData,
  DotEyes,
  DotGlasses,
  DotInboxItem,
  DotLook,
  DotMood,
  DotShape,
} from '../../types'

const SHAPE_EDGES: Record<DotShape, readonly [string, string]> = {
  round: ['(', ')'],
  square: ['[', ']'],
  soft: ['{', '}'],
  pointy: ['<', '>'],
  bubble: ['⸨', '⸩'],
}
const EYE_GLYPHS: Record<DotEyes, string> = {
  dots: '•', beady: '·', round: 'o', wide: 'O', happy: '^', star: '*', sparkle: '✦', heart: '♥',
}
const ACCESSORY_GLYPHS: Record<DotAccessory, string> = {
  none: '', crown: '♛', flower: '✿', bolt: 'ϟ', star: '★', leaf: '❦', heart: '♥',
}
const MOUTHS: Record<DotMood, string> = { idle: 'ᴗ', working: '_', 'needs-you': 'o', asleep: '‿' }
const TAILS: Record<DotMood, string> = { idle: '', working: '', 'needs-you': '!', asleep: 'ᶻ' }

export const COLOR_HEX: Record<DotColor, string> = {
  teal: '#2bb3a3', blue: '#4f8ff7', purple: '#9b7bf7', pink: '#f0609e', orange: '#f5873b',
  yellow: '#e8b923', green: '#3cc46b', red: '#ef5350', gray: '#a0a7b4',
}

export const SHAPES = Object.keys(SHAPE_EDGES) as DotShape[]
export const EYES = Object.keys(EYE_GLYPHS) as DotEyes[]
export const GLASSES: DotGlasses[] = ['none', 'round', 'square', 'shades', 'monocle']
export const ACCESSORIES = Object.keys(ACCESSORY_GLYPHS) as DotAccessory[]
export const COLORS = Object.keys(COLOR_HEX) as DotColor[]

export const DEFAULT_LOOK: DotLook = { shape: 'round', eyes: 'dots', glasses: 'none', accessory: 'none', color: 'teal' }

/** The dot as one line of text, its expression set by its mood. */
export function face(look: DotLook, mood: DotMood): string {
  const [open, close] = SHAPE_EDGES[look.shape]
  const eye = mood === 'asleep' ? '-' : EYE_GLYPHS[look.eyes]
  const mouth = MOUTHS[mood]
  const middle = {
    none: `${eye}${mouth}${eye}`,
    round: `(${eye})${mouth}(${eye})`,
    square: `[${eye}]${mouth}[${eye}]`,
    shades: `■${mouth}■`,
    monocle: `${eye}${mouth}(${eye})`,
  }[look.glasses]

  return `${ACCESSORY_GLYPHS[look.accessory]}${open}${middle}${close}${TAILS[mood]}`
}

const NEEDS_YOU: ReadonlySet<DotInboxItem['kind']> = new Set(['question', 'handoff', 'blocked'])

export function needsYou(data: DotData): DotInboxItem[] {
  return data.inbox.filter(item => !item.isDone && (item.isUrgent || NEEDS_YOU.has(item.kind)))
}

export function moodOf(data: DotData): DotMood {
  if (data.settings.isAsleep) return 'asleep'
  if (needsYou(data).length > 0) return 'needs-you'
  if (data.activity.some(one => one.status === 'running')) return 'working'

  return 'idle'
}

export function handleFor(user: string | undefined, name: string): string {
  return `@${slug(user ?? 'you')}-${slug(name)}`
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'dot'
}
