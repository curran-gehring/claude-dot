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
| A "Your dot" chat in the app | One always-on session with `DOT_FEED=1` and Remote Control, the same conversation every restart: see [Your dot in the Claude app](#your-dot-in-the-claude-app) |
| Responsibilities that "stay true over time" | `/dot assign [<when> \|] <job>`, or just tell Claude ("have my dot check CI every weekday at 9"). Claude uses the `mcp__dot__assign` tool |
| The dot decides when to check, or you set a fixed schedule | No schedule: the dot runs it while you're away, at most once per proactive interval (`proactiveMinutes`, default 2h). Fixed: `every 2h`, `hourly`, `daily 9:00`, `weekdays 9:30`, `weekends 8am`, `mon,thu 17:00` (local time) |
| Its own cloud computer | A background subagent (`dot:worker`) in the responsibility's project directory. Nothing runs in your foreground |
| Proactive research, read-only | `dot:researcher`, given only Read/Glob/Grep/WebSearch/WebFetch. The guard also refuses anything else from that agent, outside the agent's control. Runs after 10 idle minutes, at most every 2 hours per project |
| Delegating to Codex | `/dot delegate <task>` hands the task to a background worker; the result lands in the inbox |
| Activity view: running, scheduled, completed, pending decisions | `/dot` opens a pane with the inbox (`Done` / `Ask Claude`), what's running, responsibilities (`Run` / `Pause` / `Drop`), rules, notes and recent results |
| Custom Rules: act without asking, act when you say so, ask first, hand off to you | `/dot rule allow\|when-asked\|ask\|handoff <action>`. The action is a tool pattern (`Bash(git push*)`, `mcp__*__send*`, `Edit(*.env*)`) or plain words that Auto-review reads |
| Auto-review: a separate check before sensitive actions; run, ask, hand off or block | Before a consequential call (push, publish, delete, deploy, `curl -X POST`, writing outside the project or to secrets, any connector tool whose name doesn't plainly say it only reads), a small model reviews it against your recent requests and your rules. **run** leaves the decision to Claude Code; **ask** opens an Approve / Deny / Hand off dialog; **handoff** and **block** refuse the call and file an inbox item |
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
/dot check N <command>|off    a cheap pre-check before each automatic run of N
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

### Pre-checks

A scheduled job starts a full agent each time it's due, even when there's nothing to do. Give it
a shell command that checks first: `/dot check 1 ~/bin/has-new-mail.sh`. Before each automatic run,
the dot runs the command in the job's directory (`sh -c` on macOS and Linux, `cmd /c` on Windows,
with a one-minute limit). The agent starts only when the command exits 0. Any other exit skips that
run and moves the schedule on. A check that can't run at all doesn't block the job: it runs as if
there were no check. `/dot run N` always runs, without the check. Only you can set a check, with
the command; the dot's tools can't.

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

A call from one of the dot's own background jobs never waits on a dialog, because nobody is
watching that run. What would ask you is handed off instead: the call is refused and lands in the
inbox for you to do or approve. For an email send, reply or forward, both the approval dialog
and that inbox item show the whole draft: recipients, subject, body and attachments.

When no one is at the terminal (`claude -p`, the SDK), an **ask** falls back to Claude Code's own
permission mode instead of a dialog. If the guard itself fails, it answers `ask`, which Claude
Code resolves under your permission mode, the same as without the mod.

## Where things live

- All state is one JSON value in the plugin's store, under your Claude Code config directory.
  Every open session on the machine shares it. A value that fails to parse is kept under a
  `corrupt-<time>` key and reported loudly; it is never dropped.
- That store is last-writer-wins with no compare-and-set, so every write holds a lock while it
  reads, changes and writes. The lock is a `plugins/dot.lock` directory that `mkdir` creates
  atomically; the holder writes its token inside. The holder checks the token again right before
  it writes and before it releases. It writes only within a 60-second lease. A lock older than
  2 minutes belongs to a session that died while holding it. It is broken by an atomic rename,
  and put back if it changed hands in the meantime. Without compare-and-set in the store, the one
  case left is a holder that stalls more than a minute between its last check and its write. A write that can't get the lock within 5 seconds fails and says so; nothing is
  half-saved. The lock is also what keeps two sessions from starting the same job. The guard
  reads the store fresh on every call, so a rule added in one session applies in every other one
  immediately.
- Time-of-day schedules use your UTC offset at the time of the run, so `daily 9:00` stays at 9:00
  across a daylight-saving change.
- Each session writes a heartbeat. Work started by a session that closed is marked
  *interrupted*, so it can't block the next run.
- The model in your main conversation gets a short section about your dot: its
  responsibilities, recent notes and open inbox count. It also gets five tools:
  `mcp__dot__assign`, `mcp__dot__note`, `mcp__dot__status` (which lists the rules, numbered),
  `mcp__dot__resolve` to close an inbox item once it's handled, and `mcp__dot__unrule` to remove
  an **allow** rule that's no longer needed, such as a one-time permission it has used. Both name
  the item by its number and the start of its text, so a renumbered list can't hit the wrong one.
  `unrule` refuses `ask`, `handoff` and `when-asked` rules: removing one of those would give the
  dot more room, so only you can, with `/dot unrule N`.

## Settings

Under `pluginConfigs.dot` in your settings, or in the config menu:

| Option | Default | |
| --- | --- | --- |
| `proactiveMinutes` | `120` | Minutes between research passes per project. `0` turns research off |
| `idleMinutes` | `10` | How long you must be away before research starts |
| `reviewModel` | `haiku` | The model Auto-review uses |

## Your dot in the Claude app

OpenAI's dots have a "Your dot" chat pinned at the top of the app: one conversation that *is* the
dot. claude-dot does the same with one always-on session.

1. **Make one session the dot's own.** Start it with `DOT_FEED=1` in its environment. It becomes
   the dot's feed: when a background job fails, needs you, or leaves inbox items, the session
   posts it into its own conversation and the model tells you about it as the dot, in the first
   person. A routine run with nothing new posts nothing. While a feed session is open, other
   sessions leave scheduled jobs and research to it, so every result lands in one place. With
   none open they run jobs as before. Only the exact value `1` turns this on.
2. **Reach it from your phone.** Add `--remote-control <name>` and `--name <name>`. The session
   shows up under that name on claude.ai/code and in the Claude app, at the same link after a
   restart.
3. **Keep it the same conversation.** Pin its id: start it the first time with
   `--session-id <uuid>` and every time after with `--resume <uuid>`, so the history is where
   you left it.
4. **Keep it running.** Run it in tmux and have launchd, cron or a login item restart it when
   it's gone.

`scripts/dot-session.sh` does all four. It's idempotent, so run it every few minutes:

```
DOT_NAME=Ezra DOT_CWD=~/Projects scripts/dot-session.sh
```

It keeps the id in `~/.claude/dot/<name>-session-id` and runs the session in a tmux session
named `dot` (`tmux attach -t dot` to see it). Settings: `DOT_NAME`, `DOT_CWD`, `DOT_CLAUDE`
(the binary) and `DOT_CLAUDE_ARGS` (extra flags such as a permission mode). On macOS, a
LaunchAgent at `~/Library/LaunchAgents/com.you.claude-dot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.you.claude-dot</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>/path/to/claude-dot/scripts/dot-session.sh</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>DOT_NAME</key><string>Ezra</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
</dict></plist>
```

then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.you.claude-dot.plist`.

Talk to your dot there like any session: it has the dot's tools (`mcp__dot__status`,
`resolve`, `unrule` and the rest), so it can tidy its own inbox and drop allow rules it has used.

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
