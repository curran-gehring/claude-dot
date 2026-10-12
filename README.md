# claude-dot

An always-on companion for Claude Code, modeled on OpenAI's [dots](https://openai.com/index/introducing-dots/).

Your dot sits in a band above the prompt with a name and a face you choose. It keeps standing
**responsibilities** and runs them on schedules in the background. While you're away it does
**read-only research** on the project you're in. It keeps **notes** you can read and edit. Before
any consequential action runs, yours or its own, it checks the action against your **Custom
Rules** and an independent **Auto-review**.

```
(•ᴗ•) Alfred · next 09:00 Check CI on main · watching 3 · 1 needs you  [ Open ]
```

## Install

At a Claude Code prompt:

```
/plugin install dot --marketplace curran-gehring/claude-dot
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).
Then run `/dot setup` to name your dot and choose its look. Right after setup, it reads the
project and suggests two or three responsibilities it could take on.

## How it maps to dots

| OpenAI dots | claude-dot |
| --- | --- |
| A primary dot you name, with a shape, color, eyes, glasses and accessories | `/dot setup`: name, shape, eyes, glasses, accessory, color. Live preview. Its face changes with its mood: idle `(•ᴗ•)`, working `(•_•)`, needs you `(•o•)!`, asleep `(-‿-)ᶻ` |
| Responsibilities that "stay true over time" | `/dot assign [<when> \|] <job>`, or just tell Claude ("have my dot check CI every weekday at 9"). Claude uses the `mcp__dot__assign` tool |
| The dot decides when to check, or you set a fixed schedule | No schedule: it checks during research passes. Fixed: `every 2h`, `hourly`, `daily 9:00`, `weekdays 9:30`, `weekends 8am`, `mon,thu 17:00` (local time) |
| Its own cloud computer | A background subagent (`dot:worker`) in the responsibility's project directory. Nothing runs in your foreground |
| Proactive research, read-only | `dot:researcher`, given only Read/Glob/Grep/WebSearch/WebFetch. The guard also refuses anything else from that agent, outside the agent's control. Runs after 10 idle minutes, at most every 2 hours per project |
| Delegating to Codex | `/dot delegate <task>` hands the task to a background worker; the result lands in the inbox |
| Activity view: running, scheduled, completed, pending decisions | `/dot` opens a pane with the inbox (`Done` / `Ask Claude`), what's running, responsibilities (`Run` / `Pause` / `Drop`), rules, notes and recent results |
| Custom Rules: act without asking, act when you say so, ask first, hand off to you | `/dot rule allow\|when-asked\|ask\|handoff <action>`. The action is a tool pattern (`Bash(git push*)`, `mcp__*__send*`, `Edit(*.env*)`) or plain words that Auto-review reads |
| Auto-review: a separate check before sensitive actions; run, ask, hand off or block | Before a consequential call (push, publish, delete, deploy, `curl -X POST`, writing outside the project or to secrets, a connector tool that sends or changes something), a small model reviews it against your recent requests and your rules. **run** leaves the decision to Claude Code; **ask** opens an Approve / Deny / Hand off dialog; **handoff** and **block** refuse the call and file an inbox item |
| Some things always go back to you | Auto-review is instructed to always hand off changes to passwords or credentials, money transfers and purchases. For a guarantee that doesn't depend on a model, add a `handoff` rule |
| Memory you can't view or edit | **Different on purpose:** `/dot notes` lists everything it has learned, and `/dot forget N\|all` removes notes |
| Notifications | Toasts for every result; a native notification when something needs you or a run fails |

## Commands

```
/dot                          open your dot
/dot setup                    name it and choose its look
/dot assign [<when> |] <job>  give it a standing responsibility
/dot list                     responsibilities, numbered
/dot run|pause|resume|drop N  act on responsibility N
/dot inbox · /dot done N      what it has for you; mark item N handled
/dot rule <level> <action>    add a rule; /dot rules lists them, /dot unrule N removes one
/dot note <text> · /dot notes · /dot forget N|all
/dot research                 run a read-only research pass on this project now
/dot delegate <task>          hand a task to a background agent
/dot review on|off            Auto-review
/dot band on|off              the band above the prompt
/dot sleep|wake               pause all scheduled work and research
/dot reset                    start over (asks first)
```

## How the guard decides

For every tool call, through the `tool.check` hook:

1. The dot's own tools always run. A deny from your own Claude Code settings always stands. The
   dot never loosens one.
2. A call from the research agent that isn't read-only is refused.
3. The strictest matching rule applies. `handoff` refuses the call and files it, `ask` asks you,
   and `allow` lets a non-consequential call run without a prompt.
4. A consequential call, or one under a `when-asked` rule, goes to Auto-review, then to its
   verdict.
5. Everything else is left to Claude Code exactly as before.

When no one is at the terminal (`claude -p`, the SDK), an **ask** falls back to Claude Code's own
permission mode instead of a dialog. If the guard itself fails, it answers `ask`, which Claude
Code resolves under your permission mode, the same as without the mod.

## Where things live

- All state is one JSON value in the plugin's store, under your Claude Code config directory.
  Every open session on the machine shares it. A value that fails to parse is kept under a
  `corrupt-<time>` key and reported loudly; it is never dropped.
- That store is last-writer-wins, so writes are optimistic. Each value carries a revision and
  the lineage of writes it descends from. A write starts over if the revision moved since it
  read. After a short settle (`settleMs`), it re-reads: the write survived exactly when it is
  in the current lineage. If not, it redoes the change on top of what is there. That redo is also what keeps two sessions from starting the same
  job. The guard reads the store fresh on every call, so a rule added in one session applies in
  every other one immediately.
- Each session writes a heartbeat. Work started by a session that closed is marked
  *interrupted*, so it can't block the next run.
- The model in your main conversation gets a short section about your dot: its
  responsibilities, recent notes and open inbox count. It also gets three tools:
  `mcp__dot__assign`, `mcp__dot__note` and `mcp__dot__status`.

## Settings

Under `pluginConfigs.dot` in your settings, or in the config menu:

| Option | Default | |
| --- | --- | --- |
| `proactiveMinutes` | `120` | Minutes between research passes per project. `0` turns research off |
| `idleMinutes` | `10` | How long you must be away before research starts |
| `reviewModel` | `haiku` | The model Auto-review uses |
| `settleMs` | `300` | How long a write waits before checking that no other session overwrote it |

## Limits

- It runs while a Claude Code session is open. A schedule that comes due while no session is
  open runs at the next tick after one opens.
- There is no Slack, Teams or voice channel. It reaches you through the band, the pane, toasts
  and native notifications.
- Scheduled runs and research use your normal Claude usage.
- Auto-review lowers risk but does not remove it, the same caveat OpenAI gives for dots. Review
  consequential work.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/core/` holds pure logic (schedules, rules, the guard's decisions, reports, state
transitions, the avatar), each covered by `tests/`. `hooks/register.tsx` wires that logic to
Claude Code's hooks. `hooks/view.tsx` draws the band and the panes.

## License

MIT
