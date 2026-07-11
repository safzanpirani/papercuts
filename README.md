# papercuts

A tiny CLI that agents can use to complain about the bullshit they encounter
during work: dead-end tool calls, broken links, confusing setup, flaky commands,
misleading errors, and other small frustrations.

Each call appends a short entry to `PAPERCUTS.md` at the current Git project
root (outside a Git project, the current directory). The entry includes a UTC
timestamp, the exact directory the command was called from, the agent runtime,
the exact model ID, and optional tags. Every entry is also mirrored to a
cross-project JSONL log at `~/.papercuts/global.jsonl`, which `papercuts list`
reads.

## Install

```sh
cd ~/Development/papercuts
bun install
bun link

# Make the companion skill discoverable to agents.
ln -s ~/Development/papercuts/skills/papercuts ~/.agents/skills/papercuts
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
