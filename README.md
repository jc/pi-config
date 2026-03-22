# Pi configuration

This repository documents the Pi setup currently used on this machine.

## Status legend

- **Core**: part of day-to-day workflow
- **Trial**: actively testing in real work
- **Candidate**: queued to try, not actively used yet

## Extensions

| Extension | Status | Description |
| --- | --- | --- |
| [`answer`](https://github.com/mitsuhiko/agent-stuff) | Core | Adds `/answer`: extracts unanswered questions from the last assistant response and opens an interactive Q&A TUI. |
| [`review`](https://github.com/mitsuhiko/agent-stuff) | Core | Adds `/review` and `/end-review` workflows for PR/branch/commit/folder/custom reviews with review-loop support. |
| [`handoff`](https://github.com/jc/pi-handoff) | Core | Fork of handoff with save-load functionality to easily cross directory-session boundaries. |
| [`tab-status`](https://github.com/tmustier/pi-extensions) | Core | Updates the terminal tab title with Pi run state. |
| [ `execute-command`](https://github.com/HazAT/pi-config) | Core | Adds `execute_command` tool to execute slash commands/messages as user input. |
| [`runtime-secrets`](/extensions/runtime-secrets.ts) | Core | Adds in-memory runtime secret management via `/secret` commands, injects secrets into bash tool env vars, and redacts secret values from tool output. |
| [`session-breakdown`](https://github.com/mitsuhiko/agent-stuff) | Core | Adds `/session-breakdown` interactive analytics for sessions/messages/tokens/cost over 7/30/90 day ranges. |
| [`todos`](https://github.com/mitsuhiko/agent-stuff) | Trial | Adds file-backed todo management (`.pi/todos`) with commands, tool integration, locking, and interactive TUI. |
| [`todos-gather`](/extensions/todos-gather.ts) | Trial | Adds `/todos-gather` as a companion extension that imports todos from sibling git worktrees without forking the main todos extension. |
| [`pi-remote`](https://github.com/jc/pi-remote) | Trial | Fork of pi-remote with mobile-first remote Pi access, Tailscale integration, and discovery for active sessions. |
| [`pi-tau`](https://github.com/jc/tau) | Trial | Fork of Tau for browser mirroring of live Pi sessions and history, with a live-only filter and quieter mirror logging. |
| [`pi-diff-review`](https://github.com/jc/pi-diff-review) | Trial | Fork of pi-diff-review for native diff review with per-file checkpoints and checkpoint-based diff ranges. |
| [`btw`](https://github.com/noahsaso/my-pi) | Trial | Adds asynchronous side-thread commands (`/btw`, `/btw:new`, `/btw:inject`, `/btw:summarize`) with a live widget. |
| [`plannotator`](https://github.com/jc/plannotator) | Trial | Fork for code review with checkpoints and file revision range review. Very similar to Reviewable. |
| [`autoresearch-create`](https://github.com/davebcn87/pi-autoresearch) | Candidate | Runs autonomous optimization loops using `init_experiment`, `run_experiment`, and `log_experiment`. |

## Skills

| Skill | Status | Description |
| --- | --- | --- |
| [`commit`](/skills/commit) | Core | Commit style guide for generating commit messages in `jc`'s preferred format and staging only intended files. |
| [`github`](/skills/github) | Core | Usage patterns for GitHub CLI (`gh issue`, `gh pr`, `gh run`, `gh api`) during coding-agent workflows. |
| [`spec-issue`](/skills/spec-issue) | Core | Guides collaborative issue planning via interactive clarification, multiple solution options, and scoped deliverables. |
| [`visual-explainer`](https://github.com/nicobailon/visual-explainer) | Trial | Generates self-contained HTML visual explainers (architecture diagrams, tables, reviews, and recaps). |
| [`browser-tools`](https://github.com/badlogic/pi-skills) | Trial | Browser automation with Chrome DevTools Protocol for interactive frontend testing and page interaction. |
| `scurl` | Trial | Uses `scurl` to fetch URLs and extract clean markdown content suitable for LLM context. |
| [`tavily-extract`](https://github.com/tavily-ai/skills) | Trial | Extracts clean content from known URLs via Tavily extraction APIs. |
