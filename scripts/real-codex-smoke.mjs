import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

if (process.env.POCKCODE_REAL_CODEX !== "1") {
  console.log("Skipping real Codex smoke test. Set POCKCODE_REAL_CODEX=1 to run it.")
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), "pockcode-real-codex-"))
const workspace = join(root, "workspace")
const codexHome = join(root, "codex-home")
let child
let nextId = 1
const pending = new Map()
const notifications = []
let stdoutBuffer = ""

try {
  writeFileSync(join(root, "workspace-marker"), "")
  await import("node:fs/promises").then(({ mkdir, writeFile }) =>
    mkdir(workspace, { recursive: true }).then(() => writeFile(join(workspace, "README.md"), "smoke test workspace\n")),
  )

  child = spawn(process.env.CODEX_BIN ?? "codex", ["app-server", "--enable", "goals", "--enable", "collaboration_modes"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
    },
    stdio: ["pipe", "pipe", "pipe"],
  })

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8")
    const lines = stdoutBuffer.split("\n")
    stdoutBuffer = lines.pop() ?? ""
    for (const line of lines) {
      handleMessageLine(line)
    }
  })
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk)
  })
  child.on("close", (code) => {
    for (const { reject, timeout } of pending.values()) {
      clearTimeout(timeout)
      reject(new Error(`codex app-server exited with code ${code ?? "unknown"}`))
    }
    pending.clear()
  })

  await request("initialize", {
    clientInfo: { name: "pockcode-smoke", title: "pockcode smoke", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  })
  notify("initialized")

  const started = await request("thread/start", {
    cwd: workspace,
    collaborationMode: { mode: "plan" },
    approvalPolicy: "never",
    sandbox: { type: "readOnly" },
  })
  const threadId = started.result?.thread?.id
  if (!threadId) {
    throw new Error("Codex did not return a thread id.")
  }

  const turn = await request("turn/start", {
    threadId,
    cwd: workspace,
    collaborationMode: { mode: "plan" },
    input: [{ type: "text", text: "Create a two item plan for verifying this smoke test. Do not edit files." }],
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly" },
  })
  const turnId = turn.result?.turn?.id
  if (!turnId) {
    throw new Error("Codex did not return a turn id.")
  }

  await waitForNotification((message) => (
    message.method === "turn/completed" &&
    message.params?.threadId === threadId &&
    (!message.params?.turn?.id || message.params.turn.id === turnId)
  ), 120_000)

  const sawAssistantActivity = notifications.some((message) =>
    message.method === "item/completed" &&
    message.params?.threadId === threadId &&
    ["agentMessage", "plan", "reasoning"].includes(message.params?.item?.type),
  )
  if (!sawAssistantActivity) {
    throw new Error("Codex completed without visible assistant activity.")
  }

  await request("turn/interrupt", { threadId, turnId }, 10_000).catch(() => undefined)
  console.log("Real Codex smoke test passed.")
} finally {
  child?.kill("SIGTERM")
  rmSync(root, { force: true, recursive: true })
}

function request(method, params, timeoutMs = 30_000) {
  const id = `smoke-${nextId++}`
  child.stdin.write(`${JSON.stringify(params === undefined ? { id, method } : { id, method, params })}\n`)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timed out waiting for ${method}.`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timeout })
  })
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`)
}

function handleMessageLine(line) {
  const text = line.trim()
  if (!text) {
    return
  }
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  if (message.id === undefined || message.id === null) {
    notifications.push(message)
    return
  }
  const pendingRequest = pending.get(String(message.id))
  if (!pendingRequest) {
    return
  }
  clearTimeout(pendingRequest.timeout)
  pending.delete(String(message.id))
  if (message.error) {
    pendingRequest.reject(new Error(message.error.message ?? "Codex request failed."))
  } else {
    pendingRequest.resolve(message)
  }
}

function waitForNotification(predicate, timeoutMs) {
  const existing = notifications.find(predicate)
  if (existing) {
    return Promise.resolve(existing)
  }
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const interval = setInterval(() => {
      const found = notifications.find(predicate)
      if (found) {
        clearInterval(interval)
        resolve(found)
        return
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(interval)
        reject(new Error("Timed out waiting for Codex notification."))
      }
    }, 100)
  })
}
