import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getSessionMessages,
  listSessions,
  query,
} from "@anthropic-ai/claude-agent-sdk"

if (process.env.POCKCODE_REAL_CLAUDE !== "1") {
  console.log("Skipping real Claude smoke test. Set POCKCODE_REAL_CLAUDE=1 to run it.")
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), "pockcode-real-claude-"))
const workspace = join(root, "workspace")
const claudeConfigDir = join(root, "claude")
const smokeModel = process.env.CLAUDE_SMOKE_MODEL ?? "sonnet"
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR

try {
  mkdirSync(workspace, { recursive: true })
  mkdirSync(claudeConfigDir, { recursive: true })
  writeFileSync(join(workspace, "README.md"), "smoke test workspace\n")
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir

  let sessionId = null
  let sawAssistant = false
  const first = query({
    prompt: "Reply with one short sentence confirming this PockCode Claude smoke test. Do not edit files.",
    options: {
      cwd: workspace,
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir, CLAUDE_AGENT_SDK_CLIENT_APP: "pockcode-smoke" },
      maxTurns: 1,
      model: smokeModel,
      permissionMode: "default",
    },
  })
  await first.initializationResult()
  for await (const message of first) {
    sessionId = message.session_id ?? sessionId
    if (message.type === "assistant") {
      sawAssistant = true
    }
  }
  if (!sessionId) {
    throw new Error("Claude did not return a session id.")
  }
  if (!sawAssistant) {
    throw new Error("Claude completed without visible assistant activity.")
  }

  const sessions = await listSessions({ dir: workspace, includeProgrammatic: true })
  if (!sessions.some((session) => session.sessionId === sessionId)) {
    throw new Error("Claude session was not listed after the turn.")
  }

  const messages = await getSessionMessages(sessionId, { dir: workspace, includeSystemMessages: true })
  if (!messages.length) {
    throw new Error("Claude session messages were empty.")
  }

  const abortController = new AbortController()
  const interrupt = query({
    prompt: "Think briefly, then say interrupted smoke check.",
    options: {
      abortController,
      cwd: workspace,
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir, CLAUDE_AGENT_SDK_CLIENT_APP: "pockcode-smoke" },
      maxTurns: 1,
      model: smokeModel,
      resume: sessionId,
    },
  })
  await interrupt.initializationResult()
  abortController.abort()
  interrupt.close()

  console.log("Real Claude smoke test passed.")
} finally {
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  }
  rmSync(root, { force: true, recursive: true })
}
