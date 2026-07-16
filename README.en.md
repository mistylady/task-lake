# Task Lake (`tlk`)

English | [日本語](README.md)

Task Lake is a CLI for managing small tasks that don't warrant a Redmine ticket, all in a single local store.

The primary operators of Task Lake are AI agents (Claude Code, Codex, etc.). You let agents handle creating, completing, and editing tasks while you just review the resulting list. That's the intended workflow, so there are no interactive prompts or confirmation dialogs. To let agents work reliably with minimal round-trips, every command supports `--json` structured output (agents should always use it), exit codes distinguish failure types, and errors include a suggested next action (`next_step`). Mutation commands like `done` and `rm` are idempotent -- retrying after a lost response won't cause damage. The one exception is `add`: retrying creates a duplicate, so when a response is lost, check with `list` before retrying. Manual use works fine too.

## Installation

Install [Bun](https://bun.sh/), then run the following in this repository:

```sh
bun install
bun link          # registers the tlk command in ~/.bun/bin
```

If `~/.bun/bin` is not on your PATH, add it (e.g., append `export PATH="$HOME/.bun/bin:$PATH"` to your shell rc file). Verify:

```sh
tlk --help
```

There are no runtime dependencies. Without linking, you can use `bun run --silent tlk <command>` instead. Omitting `--silent` lets Bun's own log output leak into stderr, breaking the guarantee of "exactly one JSON object on stderr on error," so avoid bare `bun run tlk` when driving from an agent.

Data is stored under `~/.task-lake/` by default. During normal operation it contains two files:

```text
~/.task-lake/
├── tasks.jsonl       # task data (one JSON object per line)
└── tasks.jsonl.bak   # backup of the previous state (one generation)
```

Each mutation saves the previous state to `tasks.jsonl.bak` (one generation only). If you make a mistake, copy `.bak` back to `tasks.jsonl` to restore. A lock file `tasks.jsonl.lock` and a temporary rename target are created during writes but will not persist after normal completion.

You can override the storage directory for tests or scratch use:

```sh
TASK_LAKE_HOME=/tmp/my-task-lake tlk list --json
```

## Usage

```sh
# create
tlk add "Reply to client A" --due 2026-07-20 -l rdm:1234
tlk add "Investigate logs" --note - < investigation.txt

# list and show (default list shows open tasks only, ordered by due date)
tlk list
tlk list -l rdm:1234 --json
tlk list --all --limit 100
tlk show 12
tlk show "Reply"

# mutate by exact ID
tlk done 12 --note "Handled"
tlk reopen 12
tlk edit 12 --title "Reply to client A again" --clear-due
tlk edit 12 --add-label followup --remove-label rdm:1234
tlk edit 12 --set-labels followup,customer --note "Awaiting confirmation"
tlk rm 12

# CLI schema and data diagnostics
tlk describe
tlk describe edit --json
tlk describe --all --json
tlk validate --json
```

Every command accepts `--json`. Successful mutation results always have the shape `{"changed": boolean, "task": Task | null}`. `task` is `null` only for `rm` targeting a nonexistent ID (an idempotent no-op).

```json
{"changed":true,"task":{"id":"12","title":"Reply to client A","status":"open","labels":[],"created":"2026-07-15T21:30:00+09:00"}}
```

`list --json` returns `{"total": ..., "items": [...]}`. Items exclude `note` and include `has_note` instead. Only `show` accepts a title fragment; when multiple tasks match, it returns an error with the list of candidates. `done`, `reopen`, `edit`, and `rm` accept numeric IDs only, to prevent accidental mutations.

## Using from AI Agents

A skill-and-snippet set for teaching agents about tlk is included. Setup takes two steps:

1. Copy `skills/use-task-lake/` to your agent's skill directory (for Claude Code, that's `.claude/skills/` in the project). It contains full command examples, error recovery procedures, and pointers to `describe`, and is loaded only when a task operation is requested.
2. Paste the two lines from `AGENTS-snippet.md` into your CLAUDE.md, AGENTS.md, or equivalent instruction file. They just say "always read the `use-task-lake` skill before operating" and establish a label naming convention. Automatic skill triggering is unreliable, so explicit invocation from persistent instructions ensures consistency.

In short: the snippet is the trigger, the skill is the payload. Only two lines go into your always-loaded context. For agents other than Claude Code (e.g., Codex), the most reliable approach is to write the SKILL.md file path directly into AGENTS.md so the agent reads it.

> **Note:** `AGENTS-snippet.md` and `skills/use-task-lake/` are written in Japanese.

When an agent needs to look up flags or constraints, it can run `tlk describe <command> --json` to get a machine-readable schema.

Label conventions: use `rdm:<number>` (Redmine) and `gh:<number>` (GitHub) for ticket links. Labels themselves are free-form strings.

## Exit Codes and Errors

| exit | meaning | JSON error `code` |
|---:|---|---|
| 0 | success (including idempotent no-ops) | -- |
| 1 | I/O or internal error | `io` / `internal` |
| 2 | invalid arguments | `usage` |
| 3 | target not found | `not_found` |
| 4 | ambiguous `show` match | `ambiguous` |
| 5 | invalid argument value or stored data | `validation` |

With `--json`, failures emit exactly one JSON envelope to stderr. Nothing other than data is written to stdout.

```json
{"error":{"code":"not_found","message":"ID「12」のタスクが見つかりません","next_step":"tlk list --json でIDを確認してください"}}
```

> **Note:** CLI messages (the `message` and `next_step` fields) are currently Japanese-only. Use the `code` field for programmatic handling.

## Storage Safety

On mutation, the process acquires a lock and re-reads the latest data. It then atomically updates `tasks.jsonl.bak` with the old data, writes a temporary file in the same directory, and `rename`s it over the main file. Invalid JSONL or duplicate IDs abort the operation without writing. The lock is never forcibly stolen.

This MVP guarantees protection against partial writes on process crashes. It does not guarantee `fsync`-based durability against power loss.

## Development

```sh
bun test
bun run typecheck
```

The implementation is split into a pure-function core and a thin I/O layer. Argument parsing, help text, and `describe` all reference the same CommandSpec.
