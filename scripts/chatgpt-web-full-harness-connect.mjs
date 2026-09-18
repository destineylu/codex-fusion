import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getCodexChatGptWebSnapshot } from "../apps/control-center/electron/codex-chatgpt-web.mjs";

const tunnelId = String(process.env.CODEX_CHATGPT_WEB_TUNNEL_ID || "").trim();
const runtimeKey = String(process.env.CODEX_CHATGPT_WEB_RUNTIME_KEY || "").trim();

if (!/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) {
  throw new Error("Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters.");
}
if (runtimeKey.length < 20) {
  throw new Error("Runtime API key is missing or too short.");
}

const realConfig = path.join(os.homedir(), ".codex", "config.toml");
const beforeExists = existsSync(realConfig);
const beforeBytes = beforeExists ? readFileSync(realConfig) : undefined;
const digest = (bytes) => bytes === undefined
  ? "missing"
  : createHash("sha256").update(bytes).digest("hex");
const beforeHash = digest(beforeBytes);

const before = await getCodexChatGptWebSnapshot();
if (before.routeOwner !== "router") {
  throw new Error(`Refusing Full harness setup because the real Codex route owner is ${before.routeOwner}, not Router.`);
}
if (!before.browserReady || !before.browserSmokePassed) {
  throw new Error("Managed ChatGPT Web browser is not ready or the browser smoke test has not passed.");
}

const descriptorPath = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "codex-router-sidecars",
  "codex-chatgpt-web",
  "runtime",
  "launcher-browser.json",
);
const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
const endpoint = String(descriptor.endpoint || "").replace(/\/$/, "");
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) {
  throw new Error("Managed launcher browser descriptor is not loopback-only.");
}

async function invokeSetup() {
  const targets = await (await fetch(`${endpoint}/json/list`)).json();
  const page = targets.find((entry) => entry?.title === "Codex Web GPT" && entry?.webSocketDebuggerUrl);
  if (!page) throw new Error("Codex Web GPT renderer target was not found.");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });

  try {
    const payload = { tunnelId, runtimeKey, interactionMode: "automatic" };
    const expression = `(async()=>window.codexWebLauncher.setupMcp(${JSON.stringify(payload)}))()`;
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const remote = result?.result;
    if (remote?.subtype === "error" || remote?.exceptionDetails) {
      throw new Error(remote?.description || "Launcher Full harness setup failed.");
    }
    return remote?.value;
  } finally {
    try { ws.close(); } catch {}
  }
}

function restoreRealConfig() {
  if (beforeBytes === undefined) rmSync(realConfig, { force: true });
  else writeFileSync(realConfig, beforeBytes);
}

let result;
try {
  result = await invokeSetup();
} finally {
  const afterBytes = existsSync(realConfig) ? readFileSync(realConfig) : undefined;
  const afterHash = digest(afterBytes);
  const afterSnapshot = await getCodexChatGptWebSnapshot().catch(() => undefined);
  if (afterHash !== beforeHash || afterSnapshot?.routeOwner !== "router") {
    restoreRealConfig();
    throw new Error("Full harness setup touched the real Codex route. The exact pre-setup config was restored.");
  }
}

const after = await getCodexChatGptWebSnapshot();
console.log(JSON.stringify({
  ok: true,
  launcherResult: result?.ok === true ? "ok" : result ?? "completed",
  routeOwner: after.routeOwner,
  routeDisplay: after.routeDisplay,
  bridgeReachable: after.bridgeReachable,
  daemonOwner: after.daemonOwner,
}, null, 2));
