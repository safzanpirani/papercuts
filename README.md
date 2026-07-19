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
echo "The setup step was undocumented." | PAPERCUTS_MODEL_ID=gemini-2.5-pro papercuts
papercuts list                 # this project's papercuts, oldest → newest
papercuts list --all --json    # every project, machine-readable
papercuts list -t flaky-command --since 2026-07-01
papercuts path
```

Agent detection is automatic for common runtimes. Model detection checks
runtime-specific environment variables, the active Codex rollout identified by
`CODEX_THREAD_ID`, and the newest Claude Code transcript for the current
project. Use `--agent`/`-a` and `--model`/`-m`, or `PAPERCUTS_AGENT` and
`PAPERCUTS_MODEL_ID`, to set exact values explicitly.

Tag entries with `--tag`/`-t` (repeatable, comma-separated values allowed) so
recurring friction is countable across entries.

Use `--file` or `PAPERCUTS_FILE` to override the per-project destination. Use
`PAPERCUTS_GLOBAL_FILE` to relocate the cross-project mirror, or set it to
`off` to disable mirroring.

The companion skill is intentionally small: it teaches an agent to record a
papercut immediately, in one or two useful sentences, without interrupting the
task or turning the log into an issue tracker.
