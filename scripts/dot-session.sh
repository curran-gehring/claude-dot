#!/bin/zsh
# dot-session.sh: keeps your dot's own conversation running. One interactive Claude Code session in
# tmux, always the same conversation, reachable from claude.ai/code and the Claude app through
# Remote Control, with DOT_FEED=1 so the dot posts its results into it. Run it from launchd, cron
# or a login item every few minutes: when the session is up it does nothing, when it's gone it
# starts it again and resumes the same conversation.
#
#   DOT_NAME          what Remote Control and the session list call it (default: Dot)
#   DOT_CWD           the folder the session starts in (default: $HOME)
#   DOT_CLAUDE        the claude binary (default: claude on PATH)
#   DOT_CLAUDE_ARGS   extra flags, e.g. "--permission-mode acceptEdits" (default: none)
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
NAME="${DOT_NAME:-Dot}"
TMUX_SESSION=dot
tmux has-session -t "$TMUX_SESSION" 2>/dev/null && exit 0

CLAUDE="${DOT_CLAUDE:-$(command -v claude)}"
[ -x "$CLAUDE" ] || { echo "$(date "+%F %T") claude not found; set DOT_CLAUDE" >&2; exit 1; }
DIR="$HOME/.claude/dot"
ID_FILE="$DIR/${NAME:l}-session-id"
mkdir -p "$DIR"

# The first start mints the conversation id. `ln` claims the file atomically, so two starts at
# once end up with the same id: the loser's link fails and it reads the winner's.
if [ ! -s "$ID_FILE" ]; then
  minted=$(mktemp "$ID_FILE.XXXXXX") && uuidgen | tr '[:upper:]' '[:lower:]' > "$minted" \
    && ln "$minted" "$ID_FILE" 2>/dev/null
  rm -f "$minted"
fi
id=$(<"$ID_FILE")
[[ "$id" =~ '^[0-9a-f-]{36}$' ]] || { echo "$(date "+%F %T") $ID_FILE does not hold a session id" >&2; exit 1; }

# Resume once the conversation exists; the first start creates it under the pinned id.
if ls "$HOME"/.claude/projects/*/"$id".jsonl >/dev/null 2>&1; then how=--resume; else how=--session-id; fi
cd "${DOT_CWD:-$HOME}" || exit 1
# A second start racing this one fails here on the duplicate tmux session name, which is harmless.
tmux new-session -d -s "$TMUX_SESSION" -x 220 -y 50 -e DOT_FEED=1 \
  "$CLAUDE ${DOT_CLAUDE_ARGS:-} --remote-control ${(q)NAME} --name ${(q)NAME} $how $id" \
  && echo "$(date "+%F %T") started $NAME ($how $id)"
