import type { ElementTable, RenderElement, RenderSurface } from 'claude-code'

import type { DotData, DotIdentity, DotInboxItem, DotLook } from '../types'
import { ACCESSORIES, COLORS, COLOR_HEX, DEFAULT_LOOK, EYES, GLASSES, SHAPES, face, handleFor, moodOf, needsYou } from './core/avatar'
import { ago, formatWhen } from './core/ops'
import { describeSchedule } from './core/schedule'
import type { Offset } from './core/schedule'
import { KIND_MARK, openInbox } from './text'

/** What the drawings' buttons do; the hooks module owns every write. */
export type Actions = {
  openDot: () => void
  openLook: () => void
  markDone: (id: string) => void
  askClaude: (item: DotInboxItem) => void
  runNow: (id: string) => void
  togglePause: (id: string) => void
  drop: (id: string) => void
  removeRule: (id: string) => void
  forget: (id: string) => void
  wake: () => void
  editDraft: (change: (draft: DotIdentity) => DotIdentity) => void
  saveDraft: () => void
}

type Ui = Pick<ElementTable, 'Box' | 'Text' | 'Button'>

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export function band(ui: Ui, data: DotData, now: number, offset: Offset, act: Actions): RenderElement {
  const { Box, Text, Button } = ui
  if (data.dot === null) {
    return (
      <Box flexDirection="row">
        <Text color={COLOR_HEX.teal} bold>{face(DEFAULT_LOOK, 'idle')}</Text>
        <Text dimColor wrap="truncate-end"> Meet your dot: it keeps watch in the background while you work. </Text>
        <Button key="setup" label="Set up" onPress={act.openLook} />
      </Box>
    )
  }

  const mood = moodOf(data)
  const need = needsYou(data).length
  const fresh = openInbox(data).length - need
  const active = data.responsibilities.filter(one => !one.isPaused)
  const running = data.activity.find(one => one.status === 'running')
  const next = active
    .filter(one => one.nextRunAt !== null)
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0]
  const parts: string[] = []
  if (mood === 'asleep') parts.push('asleep')
  else if (running) parts.push(`working: ${clip(running.label, 40)}`)
  else if (next?.nextRunAt) parts.push(`next ${formatWhen(next.nextRunAt, now, offset)} ${clip(next.text, 30)}`)
  if (active.length > 0) parts.push(`watching ${active.length}`)

  const row: RenderElement[] = [
    <Text color={COLOR_HEX[data.dot.look.color]} bold>{face(data.dot.look, mood)}</Text>,
    <Text bold> {data.dot.name}</Text>,
  ]
  if (parts.length > 0) row.push(<Text dimColor wrap="truncate-end"> · {parts.join(' · ')}</Text>)
  if (need > 0) row.push(<Text color="warning"> · {need} needs you</Text>)
  if (fresh > 0) row.push(<Text color="suggestion"> · {fresh} new</Text>)
  row.push(<Text> </Text>)
  row.push(mood === 'asleep'
    ? <Button key="wake" label="Wake" onPress={act.wake} />
    : <Button key="open" label="Open" onPress={act.openDot} />)

  return <Box flexDirection="row">{row}</Box>
}

export function pane(ui: Ui, data: DotData, now: number, offset: Offset, user: string | undefined, act: Actions): RenderElement {
  const { Box, Text, Button } = ui
  if (data.dot === null) {
    return (
      <Box flexDirection="column">
        <Text>You have no dot yet.</Text>
        <Button key="setup" label="Set up your dot" variant="primary" onPress={act.openLook} />
      </Box>
    )
  }

  // One keyed box per section, so its rows never sit as unkeyed siblings of another section's.
  const section = (title: string, body: RenderElement[], empty: string): RenderElement => (
    <Box key={`section-${title.split(' ')[0]}`} flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      {body.length > 0 ? body : <Text dimColor>{empty}</Text>}
    </Box>
  )
  const need = new Set(needsYou(data).map(item => item.id))
  const inbox = openInbox(data).sort((a, b) => Number(need.has(b.id)) - Number(need.has(a.id)))
  const running = data.activity.filter(one => one.status === 'running')
  const recent = data.activity.filter(one => one.status !== 'running').slice(-6).reverse()

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={COLOR_HEX[data.dot.look.color]} bold>{face(data.dot.look, moodOf(data))}</Text>
        <Text bold>  {data.dot.name}</Text>
        <Text dimColor>  {handleFor(user, data.dot.name)}</Text>
      </Box>
      <Text dimColor>
        Auto-review {data.settings.isAutoReview ? 'on' : 'off'} · {data.rules.length} rule{data.rules.length === 1 ? '' : 's'} · {data.notes.length} note{data.notes.length === 1 ? '' : 's'}{data.settings.isAsleep ? ' · asleep' : ''}
      </Text>
      {section(`Inbox (${inbox.length})`, inbox.slice(0, 12).map(item => (
        <Box key={`inbox-${item.id}`} flexDirection="column">
          <Box flexDirection="row">
            <Text color={need.has(item.id) ? 'warning' : 'suggestion'} bold={need.has(item.id)}>{KIND_MARK[item.kind]} {item.title}</Text>
            <Text dimColor>  {ago(item.at, now)}  </Text>
            <Button key={`done-${item.id}`} label="Done" onPress={() => act.markDone(item.id)} />
            <Button key={`ask-${item.id}`} label="Ask Claude" onPress={() => act.askClaude(item)} />
          </Box>
          <Text dimColor>   {clip(item.body, 600)}</Text>
        </Box>
      )), 'Nothing for you right now.')}
      {section('Working on', running.map(one => (
        <Text key={`run-${one.id}`}>● {one.label} <Text dimColor>({one.kind}, started {ago(one.startedAt, now)})</Text></Text>
      )), 'Nothing running.')}
      {section('Responsibilities', data.responsibilities.map(one => (
        <Box key={`resp-${one.id}`} flexDirection="column">
          <Box flexDirection="row">
            <Text dimColor={one.isPaused}>{one.text}</Text>
            <Text dimColor>  {one.isPaused ? 'paused' : describeSchedule(one.schedule)}{!one.isPaused && one.nextRunAt ? `, next ${formatWhen(one.nextRunAt, now, offset)}` : ''}  </Text>
            <Button key={`runnow-${one.id}`} label="Run" onPress={() => act.runNow(one.id)} />
            <Button key={`pause-${one.id}`} label={one.isPaused ? 'Resume' : 'Pause'} onPress={() => act.togglePause(one.id)} />
            <Button key={`drop-${one.id}`} label="Drop" onPress={() => act.drop(one.id)} />
          </Box>
          {one.lastSummary ? <Text dimColor>   last: {clip(one.lastSummary, 300)}</Text> : <Text dimColor>   not run yet</Text>}
        </Box>
      )), 'None yet: /dot assign <when> | <job>')}
      {section('Rules', data.rules.map(rule => (
        <Box key={`rule-${rule.id}`} flexDirection="row">
          <Text>[{rule.level}] {rule.action}  </Text>
          <Button key={`unrule-${rule.id}`} label="Remove" onPress={() => act.removeRule(rule.id)} />
        </Box>
      )), 'None: /dot rule <allow|when-asked|ask|handoff> <action>')}
      {section('Notes (what it knows)', data.notes.slice(-15).reverse().map(note => (
        <Box key={`note-${note.id}`} flexDirection="row">
          <Text>{clip(note.text, 200)} <Text dimColor>({note.source})</Text>  </Text>
          <Button key={`forget-${note.id}`} label="Forget" onPress={() => act.forget(note.id)} />
        </Box>
      )), 'Its notebook is empty.')}
      {section('Recently', recent.map(one => (
        <Text key={`recent-${one.id}`} dimColor>{one.status === 'done' ? '✓' : '✗'} {one.label}: {clip(one.summary ?? '', 200)} ({ago(one.endedAt ?? one.startedAt, now)})</Text>
      )), 'Nothing yet.')}
    </Box>
  )
}

const LABELS = (values: readonly string[]) => values.map(value => ({ value, label: value }))

export function look(table: ElementTable, surface: RenderSurface, draft: DotIdentity, act: Actions): RenderElement {
  const { Box, Text, Button } = table
  const preview = (
    <Box flexDirection="row">
      <Text color={COLOR_HEX[draft.look.color]} bold>{face(draft.look, 'idle')}</Text>
      <Text bold>  {draft.name}</Text>
    </Box>
  )
  // A phone has no text field or picker: it shows the dot and points elsewhere.
  if (surface === 'mobile' || !('Select' in table) || !('Input' in table)) {
    return (
      <Box flexDirection="column">
        {preview}
        <Text dimColor>Choose its name and look from the terminal or the desktop app: /dot setup</Text>
      </Box>
    )
  }

  const { Input, Select } = table
  const pick = <K extends keyof DotLook>(key: K, values: readonly DotLook[K][]) => (
    <Select
      key={`look-${key}`}
      label={key}
      options={LABELS(values)}
      value={draft.look[key]}
      onSelect={value => act.editDraft(d => ({ ...d, look: { ...d.look, [key]: value } }))}
    />
  )

  return (
    <Box flexDirection="column">
      {preview}
      <Text> </Text>
      <Input
        key="name"
        label="Name"
        value={draft.name}
        placeholder="Alfred"
        autoFocus
        onInput={value => act.editDraft(d => ({ ...d, name: value }))}
        onSubmit={value => act.editDraft(d => ({ ...d, name: value }))}
      />
      {pick('shape', SHAPES)}
      {pick('eyes', EYES)}
      {pick('glasses', GLASSES)}
      {pick('accessory', ACCESSORIES)}
      {pick('color', COLORS)}
      <Text> </Text>
      <Button key="save" label="Save" variant="primary" onPress={act.saveDraft} />
    </Box>
  )
}
