# Provider Integration Gaps: Codex to Claude Code

This document captures the research behind the Claude Code provider integration and the Codex-shaped blocks that needed generic handling.

## Research Inputs

- Happy (`slopus/happy`) wraps both Claude Code and Codex and uses `@anthropic-ai/claude-agent-sdk` for remote Claude turns. Its useful patterns are: local Claude transcript scanning, SDK streaming for remote turns, `canUseTool` permission bridging, MCP config injection, and careful mapping of Claude sidechain/subagent events.
- Claude Agent SDK docs establish the preferred host API: `query()`, `canUseTool`, `onElicitation`, session helpers (`listSessions`, `getSessionMessages`, `renameSession`, `forkSession`, `deleteSession`), model catalog, MCP status, account info, usage, and context APIs.
- Claude CLI session docs confirm transcripts live under `CLAUDE_CONFIG_DIR` or `~/.claude/projects/<project>/<session-id>.jsonl`; direct JSONL parsing is internal and should be fallback-only.
- Claude memory docs confirm provider instructions should target `CLAUDE.md`, while Codex continues to use `AGENTS.md`.

## Codex-Shaped Blocks Found In PockCode

- MCP service imported Codex helpers directly, wrote Codex TOML itself, and rejected non-Codex accounts.
- Chat status monitoring watched only Codex homes and parsed only Codex history change filenames.
- Instructions API/UI targeted `/api/providers/codex/instructions` and showed `AGENTS.md` only.
- Provider account auth UI rendered fixed Browser/Local actions instead of provider-declared auth modes.
- Frontend fallback models/runtime defaults/slash-command copy were Codex-only.
- Provider icon rendering had a Codex mark and generic fallback only.

## Implemented Generic Blocks

- Provider definitions now expose `authModes`, and field definitions can expose `options`.
- Provider adapters can provide MCP sync/status/OAuth, history watch paths/change parsing, and instructions read/update.
- MCP records remain shared and provider-keyed; Codex writes TOML in its adapter, while Claude injects dynamic MCP server config into SDK turns. The `mcp` capability means a provider can use MCP servers; `mcpOauth` is separate and means PockCode can launch a pre-chat OAuth flow.
- History monitoring asks all providers for watch paths and change parsing.
- Instructions routing is generic at `/api/providers/:providerId/instructions`; the old Codex path remains compatible.
- Account auth UI reads provider auth modes, so Claude exposes isolated Environment auth and Codex exposes Browser/Device/Local.

## Claude Provider Mapping

- Authentication:
  - `environment` uses official SDK/API-provider environment variables stored on each provider account.
  - Claude intentionally does not expose shared local auth; each account gets its own `CLAUDE_CONFIG_DIR` under the provider accounts home unless `claudeConfigDir` is explicitly set from the provider account config UI.
  - Inherited shell environment is scrubbed of Claude auth variables before account environment is added, so multiple Claude accounts can run simultaneously with separate credentials.
- Runtime:
  - Uses `query()` with `resume` for existing threads and SDK session ids for new threads.
  - Tracks active turns for interruption and pending permission/user-input requests.
  - Passes per-account config dir, sanitized inherited environment, account environment, model, effort, permission mode, settings, and MCP servers into SDK options.
- History/lifecycle:
  - Uses SDK helpers for list/load/rename/fork/delete.
  - Copies transcript files between per-account config dirs and the canonical PockCode Claude history dir for account switching.
- Messages:
  - Maps text, thinking, tool calls/results, Bash, edits, subagents, compaction, warnings, permission denials, and errors into existing PockCode message kinds.
- Permissions:
  - Bridges `canUseTool`, `AskUserQuestion`, user dialogs, and MCP elicitations through existing server-request responses.
  - Supports one-time approval and Claude SDK permission suggestions for session-level approval.
- Known non-equivalence:
  - Codex has native `review/start`; Claude review is implemented as a review prompt, optionally after forking for detached delivery.
  - Claude MCP OAuth/form flows occur as SDK elicitations during runtime, not as a Codex-style pre-login API.
