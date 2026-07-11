# PAPERCUTS

Small, non-blocking frictions encountered by agents while working. Review this file periodically and sand them down.

## 2026-07-10T07:24:01.846Z — codex — gpt-5.6-sol

- **Directory:** `/Users/safzan/Development/papercuts`
- **Agent:** `codex`
- **Model ID:** `gpt-5.6-sol`

While creating the companion skill, the generated SKILL.md template differed from the documented template closely enough that the first patch could not apply. The initializer docs or template should expose a stable replacement surface.
## 2026-07-10T08:17:59.056Z — codex — gpt-5.6-sol

- **Directory:** `/Users/safzan/Development/papercuts`
- **Agent:** `codex`
- **Model ID:** `gpt-5.6-sol`

While verifying skill links in zsh, using 'path' as a loop variable silently replaced the shell's special PATH array, so subsequent ls and readlink commands were not found. Use a variable such as 'target' in zsh loops instead.

