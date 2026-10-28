# claude-dot review rules

Sent to the adversarial review lenses when a diff touches a matching path. Each rule records a defect that shipped or was caught once. Add a rule when a reviewer could have seen the defect in the diff.

## Shared store
paths: hooks/register.tsx hooks/state.ts hooks/core/data.ts hooks/core/ops.ts hooks/core/report.ts

- The store is one JSON value shared by every session on the machine, with no compare-and-set. Every write goes through `mutate` and `withLock`: an mkdir lock directory, a token-owned `owner` file, the `isHeld()` fence checked right before `$.store.set`, a write only within `LOCK_LEASE_MS`, and a release only while the token still matches. A raw `$.store.set(STORE_KEY, ...)` elsewhere, an unfenced write, or a release that does not check the token brings back lost updates (fixed in five successive rounds: optimistic write, lineage check, mkdir lock, token ownership, lease).
- Setting aside an unparsable store (the `corrupt-<time>` copy, then the reset) is itself a locked, fenced write that re-checks the lock between the backup and the reset. The raw value is never dropped.
- A spawned agent's id is saved with a retry each tick, and the agent's answer is held until its report is saved. Dropping either loses a finished run. `abandonClaim` undoes only what that claim set: no time that has moved on since, and nothing once the activity is no longer running.
- A report is clipped to `LIMITS` (`parseReport`) before it reaches the shared store.

## Guard decisions
paths: hooks/core/decide.ts hooks/core/rules.ts hooks/core/review.ts hooks/prompts.ts hooks/register.tsx

- "Inside the project" resolves `.` and `..` first (`resolved` and `isInside` in rules.ts). `<project>/../secrets` is outside, and a relative path is never inside.
- A connector tool (`mcp__*`) skips review only when its name contains a read verb and no write verb. Unknown names are reviewed. Do not add a verb to `READ_VERBS` that can also write.
- The research agent is recognised by its agent type (`RESEARCHER`), not by prompt text, and `READ_ONLY_TOOLS` stays read-only (TodoWrite was refused there too).
- For a send, reply or forward, the text shown for approval is the whole draft (`callDetail`), never clipped: an approval covers only what the person saw.

## Schedules, reports and checks
paths: hooks/core/schedule.ts hooks/core/json.ts hooks/core/report.ts hooks/register.tsx

- A time-of-day schedule reads the UTC offset in force on the day it runs and settles on it (`nextRunAt` with `offsetOf`), not today's offset, so `daily 9:00` stays at 9:00 across DST. Intervals are bounded by `MAX_INTERVAL_MINUTES` and hour and minute values are range-checked.
- `lastJsonObject` must stay a string-aware brace matcher that prefers a fenced block, then the last enclosing object, in linear time with `MAX_TRIES`. A first-brace slice or a regex misreads braces inside strings and nested objects, and a quadratic scan stalls on a long answer.
- `isWanted` skips a run on any non-zero exit and runs the job when the check cannot be launched. On Windows the check runs as `cmd /d /s /c`, so a `~/x.sh` check always "failed" and silently skipped Ezra's checked jobs for two hours. Changes to its argv must keep a short-path `bash.exe -lc <script>` check working (no spaces or quotes for Node's argv escaping to mangle), and the README must keep saying `cmd` is used.

## Mod API ($)
paths: hooks/register.tsx hooks/view.tsx tests/*

- Every function that receives `$` is a top-level function declaration in `hooks/register.tsx`. A helper in another file, or a closure inside `register`, fails `claude plugin validate`. Pure logic stays in `hooks/core/*`.
- Atoms passed to `update($, ATOM, ...)` are declared in that same hooks module, not imported.
- A `ui.render` hook must not write. Read with `(await read($, ATOM)) ?? (await load-from-store)`.
- Branch on `e.surface === 'mobile'`; the mobile element table still has `Select` and `Input` keys, so `'Select' in table` passes and the controls are silently dropped.
- A guard that must reach a person uses `$.ui.ask`: a `tool.check` "ask" is decided by the permission mode and passes under bypassPermissions, where Ezra runs.
- An atom redraws only on this session's writes. Changes made by other sessions are picked up by the 10-second poll and on each prompt and turn end, updating the atom only when the JSON differs.
- Test doubles for `$` operations answer `{ value }`; a bare value is "not a result object" and the plugin hook is skipped.
