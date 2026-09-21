import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const checks = [];
function check(label, condition, detail = "") {
  checks.push({ label, ok: Boolean(condition), detail });
}

function includesAll(text, values) {
  return values.every((value) => text.includes(value));
}

const readme = read("README.md");
const installPs1 = read("install.ps1");
const installSh = read("install.sh");
const updater = read("src/update.mjs");
const accountProfiles = read("apps/control-center/electron/codex-account-profiles.mjs");
const settingsPage = read("apps/control-center/src/pages/SettingsPage.tsx");
const chatgptWeb = read("apps/control-center/electron/codex-chatgpt-web.mjs");
const autoResume = read("apps/control-center/electron/codex-auto-resume.mjs");
const provider = JSON.parse(read("config/chatgpt-web/chatgpt-web.json"));
const harnessPs1 = read("scripts/chatgpt-web-full-harness-connect.ps1");
const harnessMjs = read("scripts/chatgpt-web-full-harness-connect.mjs");
const reproducibleDoc = read("docs/REPRODUCIBLE-V1.md");
const notice = read("NOTICE.md");

check(
  "README installs from destineylu/codex-fusion main",
  includesAll(readme, [
    "raw.githubusercontent.com/destineylu/codex-fusion/main/install.ps1",
    "raw.githubusercontent.com/destineylu/codex-fusion/main/install.sh",
  ]),
);
check(
  "README contains novice ChatGPT Web setup",
  includesAll(readme, [
    "Managed Start",
    "Browser smoke test",
    "Start 17841",
    "Codex Native2",
    "Tunnel ID",
    "API key",
    "Fetch model list",
    "Verify isolation",
  ]),
);
check(
  "README contains API-provider setup",
  includesAll(readme, [
    "Connect provider",
    "Save credential",
    "Add models",
    "API Provider",
  ]),
);
check(
  "Windows installer defaults to Codex Fusion distribution + Router reference upstream",
  includesAll(installPs1, [
    "https://github.com/destineylu/codex-fusion.git",
    "https://github.com/destineylu/codex-router",
    "https://github.com/duolahypercho/codex-router.git",
    "CODEX_ROUTER_UPDATE_BRANCH",
  ]),
);
check(
  "POSIX installer defaults to Codex Fusion distribution + Router reference upstream",
  includesAll(installSh, [
    "https://github.com/destineylu/codex-fusion.git",
    "https://github.com/destineylu/codex-router",
    "https://github.com/duolahypercho/codex-router.git",
    "CODEX_ROUTER_UPDATE_BRANCH",
  ]),
);
check(
  "self-updater recognizes Codex Fusion and legacy Destiney repository names",
  includesAll(updater, [
    "destineylu/codex-fusion",
    "destineylu/codex-router",
    "CODEX_ROUTER_UPDATE_BRANCH",
  ]),
);
check(
  "Native ChatGPT account profiles remain reproducible and Router-independent",
  includesAll(accountProfiles, [
    "startCodexAccountBrowserLogin",
    "submitCodexAccountCallback",
    "startCodexAccountDeviceLogin",
    "switchCodexAccount",
    "routerRestartRequired: false",
    "configMutationRequired: false",
    "isWindowsCodexDesktopExecutable",
  ]) &&
    includesAll(settingsPage, [
      "ChatGPT 原生账号",
      "浏览器 OAuth / 无痕登录（推荐）",
      "提交回调 URL",
      "Router 始终保持运行",
    ]) &&
    includesAll(readme, [
      "第 3.5 步：原生 GPT 多账号切换",
      "不会停止或重启 Router 4202/4203",
    ]),
);
check(
  "ChatGPT Web stays pinned to audited v5.0.8 and loopback 17841",
  includesAll(chatgptWeb, [
    'CODEX_CHATGPT_WEB_AUDITED_VERSION = "5.0.8"',
    'CODEX_CHATGPT_WEB_BASE_URL = "http://127.0.0.1:17841/v1"',
    "83224d59506462ab2976f437bfaea96b046d4ed55caa7e1cfd6a3d61de0a8ff3",
    "cde52e0be0ae8618e65813587ca3ac153961512b8be30725fcd4f6b6d53d0e05",
    "d993d21285c0a5a092a0f924cc3685722f1b682221bfec762c21ee49eac3baa2",
  ]),
);
check(
  "ChatGPT Web provider is keyless loopback native-session auth and opt-in",
  provider?.providers?.[0]?.id === "chatgpt-web" &&
    provider.providers[0].baseUrl === "http://127.0.0.1:17841/v1" &&
    provider.providers[0].keyless === true &&
    provider.providers[0].nativeSessionAuth === true &&
    provider.providers[0].defaultEnabled === false,
);
check(
  "Full Harness PowerShell keeps runtime key out of argv/history",
  includesAll(harnessPs1, [
    "-AsSecureString",
    "CODEX_CHATGPT_WEB_TUNNEL_ID",
    "CODEX_CHATGPT_WEB_RUNTIME_KEY",
    "ZeroFreeBSTR",
    "Remove-Item Env:CODEX_CHATGPT_WEB_RUNTIME_KEY",
  ]),
);
check(
  "Full Harness adapter fails closed if Router does not own Codex route",
  includesAll(harnessMjs, [
    'before.routeOwner !== "router"',
    "browserSmokePassed",
    "restoreRealConfig",
    'afterSnapshot?.routeOwner !== "router"',
  ]),
);
check(
  "Auto Resume remains pinned, conservative, and native-account scoped",
  includesAll(autoResume, [
    "1b2dae9d862573adc727b8d273d2760785344351",
    "auto_redeem_weekly_reset",
    "setAutoRedeemWeeklyReset(false, options)",
    "ACCOUNT_BINDINGS_VERSION",
    "accountFingerprint",
    "account-mismatch",
    "pauseCodexAutoResumeForAccountSwitch",
    "restoreCodexAutoResumeAfterAccountSwitch",
  ]) &&
    includesAll(settingsPage, [
      "原生账号作用域",
      "绑定到当前账号",
      "accountFingerprint",
    ]),
);
check(
  "Reproducible-v1 upgrade contract remains documented",
  includesAll(reproducibleDoc, [
    "destineylu/codex-fusion",
    "duolahypercho/codex-router",
    "miuuyy/codex-chatgpt-web",
    "feifeigong/codex-auto-resume",
    "npm run upstream:status",
  ]),
);
check(
  "Core upstream authorship and attribution remain explicit",
  includesAll(notice, [
    "duolahypercho/codex-router",
    "miuuyy/codex-chatgpt-web",
    "feifeigong/codex-auto-resume",
    "opencodex",
    "devin-2api",
  ]),
);

const releaseSensitive = [
  ["README.md", readme],
  ["AGENTS.md", read("AGENTS.md")],
  ["install.ps1", installPs1],
  ["install.sh", installSh],
  ["src/update.mjs", updater],
  ["apps/control-center/electron/ipc.mjs", read("apps/control-center/electron/ipc.mjs")],
  ["apps/control-center/electron/codex-account-profiles.mjs", accountProfiles],
  ["apps/control-center/src/pages/SettingsPage.tsx", settingsPage],
  ["apps/control-center/electron/codex-chatgpt-web.mjs", chatgptWeb],
  ["apps/control-center/electron/codex-auto-resume.mjs", autoResume],
  ["docs/REPRODUCIBLE-V1.md", reproducibleDoc],
  ["NOTICE.md", notice],
];

const personalPatterns = [
  /C:\\Users\\73428/i,
  /F:\\程序\\office-leasing-ai/i,
  /100\.126\.167\.68/,
  /100\.99\.180\.76/,
  /192\.220\.11\.65/,
];
const secretPatterns = [
  /tunnel_[a-f0-9]{32}/,
  /sk-[A-Za-z0-9_-]{24,}/,
  /Bearer\s+[A-Za-z0-9._-]{24,}/i,
];

const personalHits = [];
const secretHits = [];
for (const [file, text] of releaseSensitive) {
  for (const pattern of personalPatterns) {
    if (pattern.test(text)) personalHits.push(`${file}: ${pattern}`);
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) secretHits.push(`${file}: ${pattern}`);
  }
}
check("release defaults contain no maintainer-specific paths/IPs", personalHits.length === 0, personalHits.join("; "));
check("release-sensitive files contain no credential-shaped literal", secretHits.length === 0, secretHits.join("; "));

let failed = 0;
for (const item of checks) {
  if (item.ok) {
    console.log(`PASS  ${item.label}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${item.label}${item.detail ? ` — ${item.detail}` : ""}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} reproducibility checks passed.`);
if (failed) process.exit(1);
