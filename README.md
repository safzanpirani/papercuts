<h1 align="center">papercuts</h1>

<p align="center">
  A tiny CLI that agents can use to complain about the bullshit they hit during
  work — dead-end tool calls, broken links, flaky commands, misleading errors —
  so recurring pain becomes countable and easy to sand down later.
</p>

```sh
papercuts -a codex -t broken-link "The docs linked to a removed API endpoint."
```

Each call appends a dated entry to a `PAPERCUTS.md` at your project root:

```md
## 2026-07-19T14:22:07.913Z — codex — gpt-5.6-sol

- **Directory:** `/Users/you/Development/papercuts`
- **Tags:** `broken-link`

The docs linked to a removed API endpoint.
```

**How it works, at a glance:**

- 📝 **Logs to `PAPERCUTS.md`** at the current Git project root (or the current
  directory when you're outside a repo).
- 🔎 **Auto-detects context** — UTC timestamp, working directory, agent runtime,
  and the exact model ID, so you never have to guess who hit what.
- 🌍 **Mirrors everything** to a cross-project log at `~/.papercuts/global.jsonl`
  that `papercuts list` reads, filters, and searches.

## Install

### Just the skill

To install only the companion skill (discoverable across Claude Code, Codex,
Cline, and 40+ other agent runtimes):

```sh
npx skills add https://github.com/safzanpirani/papercuts -g
```

### The full CLI

Requires [Bun](https://bun.sh) — the CLI uses Bun APIs and won't run under plain
Node. (For Bun-less machines, see the compiled-binary option below.)

```sh
git clone https://github.com/safzanpirani/papercuts.git
cd papercuts
bun install
bun link

# Make the companion skill discoverable to agents.
ln -s "$PWD/skills/papercuts" ~/.agents/skills/papercuts
```

For machines and containers without bun, compile a self-contained binary and
put it on the PATH:

```sh
bun run build            # produces dist/papercuts (no runtime needed)
cp dist/papercuts ~/.local/bin/
```

## Usage

```sh
papercuts --agent codex --model gpt-5.6-sol "The docs linked to a removed endpoint."
papercuts -a claude-code -m claude-opus-4-6 -t flaky-command "The test command assumes a different working directory."
papercuts -b fleet -t remote-ops "fleet cp accepts one source file, but the docs show several."
echo "The setup step was undocumented." | PAPERCUTS_MODEL_ID=gemini-2.5-pro papercuts
papercuts list                 # this project's OPEN papercuts, oldest → newest
papercuts list --all --json    # every project, machine-readable
papercuts list -t flaky-command --since 2026-07-01
papercuts list -b fleet --all  # everything logged about one tool
papercuts top about --all      # what recurs most, by subject
papercuts top tag --all -n 10
papercuts tags                 # canonical vocabulary + what's in use
papercuts bump 29558a          # hit the same friction again
papercuts resolve 29558a --note "Added a targeted error in cli.ts."
papercuts path
```

Agent detection is automatic for common runtimes. Model detection checks
runtime-specific environment variables, the active Codex rollout identified by
`CODEX_THREAD_ID`, and the newest Claude Code transcript for the current
project. Codex date partitions remain a newest-first serial scan. Claude transcript
metadata uses an eight-file stat pool, skips files that disappear between listing and
stat, and sorts by mtime with a stable path tie-break, so completion timing cannot
change which transcript wins. Use `--agent`/`-a` and `--model`/`-m`, or
`PAPERCUTS_AGENT` and `PAPERCUTS_MODEL_ID`, to set exact values explicitly.

Tag entries with `--tag`/`-t` (repeatable, comma-separated values allowed) so
recurring friction is countable across entries. Tags are folded onto a closed
vocabulary (`papercuts tags`) — `fleet-cli` and `ssh` both become `remote-ops`,
so near-duplicate tags cannot fragment the counts. A tag outside the vocabulary
is still stored, with a warning and a suggestion.

Name the subject with `--about`/`-b` when the friction belongs to a tool rather
than the repo you are standing in. Friction about a CLI or MCP server is usually
hit from some other project, so `--about` is what lets `papercuts top about`
group it and `papercuts list -b <tool>` retrieve it. Map a subject to the repo
that owns it in `~/.papercuts/subjects.json` and the entry is also filed there:

```json
{ "fleet": "/Users/me/Development/fleet" }
```

Each entry carries a short ID and a status. `papercuts list` shows open ones by
default; `papercuts resolve <id> --note "<fix>"` closes one and annotates both
the Markdown log and the mirror, and `papercuts bump <id>` counts a repeat
instead of appending a near-duplicate. `add` compares each new message against
open entries and points at a likely match. Entries written before IDs and
statuses existed get both derived on read, so old logs keep working unchanged.

Lifecycle annotations match an entry's ID first; timestamp matching applies only to legacy headings without IDs. Bumping a resolved entry reopens it and clears its current resolution fields. The Markdown log retains the resolution and repeat history.

Use `--file` or `PAPERCUTS_FILE` to override the per-project destination. Use
`PAPERCUTS_GLOBAL_FILE` to relocate the cross-project mirror, or set it to
`off` to disable mirroring. Papercuts always completes the primary Markdown append
first. After that succeeds, it writes distinct subject and global mirror destinations
concurrently. Duplicate resolved paths receive one write, which prevents a subject map
and global override from double-appending the same file. Lifecycle updates such as
`resolve` and `bump` remain serial read-modify-write operations.

Concurrent writers use process-shared locks. A lock records its process ID and
a unique ownership token. Later writers recover locks after the owner exits.
Waiters fail after ten seconds if the owner stays alive; they never evict a slow
live writer. Locks require cooperating clients on the same host and consistent
destination paths. Older clients do not participate in this protocol.

Lifecycle updates publish Markdown before JSON and attempt rollback on ordinary
write failures. A process kill can interrupt a multi-file update and leave
unfinished temporary files. Lock recovery restores access but does not repair
partially published history.

The companion skill is intentionally small: it teaches an agent to record a
papercut immediately, in one or two useful sentences, without interrupting the
task or turning the log into an issue tracker.
