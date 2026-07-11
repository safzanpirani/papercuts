---
name: papercuts
description: A tiny "papercuts" CLI tool that agents can use to complain about bullshit they encounter during work, like dead-end tool calls, broken links, or other frustrations. Use it proactively when small, non-blocking friction reveals something in a repo or workflow that should be sanded down later.
---

# Log papercuts

Record small friction immediately without interrupting the task.

1. Write one or two sentences: what you were doing, what got in the way, and, when useful, a likely cause or fix.
2. Identify both your agent runtime and exact model ID. Never shorten, generalize, or guess the model ID.
3. Run `papercuts --agent <your-agent-name> --model <exact-model-id> "<message>"` from the directory where the friction occurred. Omit `--model` only when the runtime exposes the exact ID for automatic detection. When the friction fits an obvious category (for example `flaky-command`, `broken-link`, `docs`, `stale-cache`, `misleading-error`), add it with `--tag <category>` so recurring friction is countable.
4. Continue the original task. Mention the papercut to the user only when it materially affects the result.

Use this for missed or dead-end tool calls, broken links, confusing or undocumented setup, flaky commands, stale caches, misleading errors, and non-obvious gotchas.

Do not use `PAPERCUTS.md` as a substitute for a real bug report, tracked work, or the final account of what was accomplished. Never include secrets, tokens, private user data, or raw credentials.

The CLI writes to `PAPERCUTS.md` at the enclosing Git root and records the timestamp, invocation directory, agent runtime, and exact model ID. If `papercuts` is unavailable, continue the task and briefly report that the logging tool is not installed; do not create a different log format by hand.
