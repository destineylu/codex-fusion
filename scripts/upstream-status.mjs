import { execFileSync } from "node:child_process";

import {
  CODEX_AUTO_RESUME_AUDITED_COMMIT,
  CODEX_AUTO_RESUME_REPOSITORY,
} from "../apps/control-center/electron/codex-auto-resume.mjs";
import {
  CODEX_CHATGPT_WEB_AUDITED_VERSION,
  CODEX_CHATGPT_WEB_REPOSITORY,
} from "../apps/control-center/electron/codex-chatgpt-web.mjs";

const DISTRIBUTION_REPOSITORY = "https://github.com/destineylu/codex-fusion.git";
const ROUTER_UPSTREAM_REPOSITORY = "https://github.com/duolahypercho/codex-router.git";
const args = new Set(process.argv.slice(2));
const json = args.has("--json");

function git(args, fallback = undefined) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    }).trim();
  } catch {
    return fallback;
  }
}

async function githubJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "destineylu-codex-fusion-upstream-status",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function probe(label, fn) {
  try {
    return { label, ok: true, ...(await fn()) };
  } catch (error) {
    return {
      label,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const origin = git(["remote", "get-url", "origin"]);
const upstream = git(["remote", "get-url", "upstream"]);
const destiney = git(["remote", "get-url", "destiney"]);
const isDistribution = (value) => /github\.com[/:]destineylu\/(?:codex-fusion|codex-router)(?:\.git)?$/i.test(String(value || ""));
const isReference = (value) => /github\.com[/:]duolahypercho\/codex-router(?:\.git)?$/i.test(String(value || ""));
const local = {
  head: git(["rev-parse", "HEAD"]),
  branch: git(["branch", "--show-current"]),
  origin,
  upstream,
  destiney,
  distributionRemote: [origin, destiney].find(isDistribution),
  referenceRemote: [upstream, origin].find(isReference),
};

const [router, chatgptWeb, autoResume] = await Promise.all([
  probe("router", async () => {
    const data = await githubJson("https://api.github.com/repos/duolahypercho/codex-router/commits/main");
    return {
      repository: ROUTER_UPSTREAM_REPOSITORY,
      latestMain: data.sha,
    };
  }),
  probe("chatgpt-web", async () => {
    const data = await githubJson("https://api.github.com/repos/miuuyy/codex-chatgpt-web/releases/latest");
    const latest = String(data.tag_name || "").replace(/^v/, "");
    return {
      repository: CODEX_CHATGPT_WEB_REPOSITORY,
      auditedVersion: CODEX_CHATGPT_WEB_AUDITED_VERSION,
      latestRelease: latest || undefined,
      reviewRequired: Boolean(latest && latest !== CODEX_CHATGPT_WEB_AUDITED_VERSION),
    };
  }),
  probe("codex-auto-resume", async () => {
    const data = await githubJson("https://api.github.com/repos/feifeigong/codex-auto-resume/commits/main");
    return {
      repository: CODEX_AUTO_RESUME_REPOSITORY,
      auditedCommit: CODEX_AUTO_RESUME_AUDITED_COMMIT,
      latestMain: data.sha,
      reviewRequired: Boolean(data.sha && data.sha !== CODEX_AUTO_RESUME_AUDITED_COMMIT),
    };
  }),
]);

const result = {
  distribution: {
    repository: DISTRIBUTION_REPOSITORY,
    updateBranch: process.env.CODEX_ROUTER_UPDATE_BRANCH || "main",
  },
  local,
  upstreams: {
    router,
    chatgptWeb,
    autoResume,
  },
};

if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const short = (value) => value ? String(value).slice(0, 12) : "unknown";
  console.log("Destiney Codex Router upstream status");
  console.log(`  local:       ${short(local.head)}  branch=${local.branch || "(detached)"}`);
  console.log(`  origin:      ${local.origin || "missing"}`);
  console.log(`  distribution:${local.distributionRemote ? ` ${local.distributionRemote}` : " missing"}`);
  console.log(`  reference:   ${local.referenceRemote || "missing"}`);
  console.log("");
  console.log(`Router upstream: ${router.ok ? short(router.latestMain) : `unavailable (${router.error})`}`);
  if (chatgptWeb.ok) {
    console.log(
      `ChatGPT Web:    audited=${chatgptWeb.auditedVersion} latest=${chatgptWeb.latestRelease || "unknown"}${chatgptWeb.reviewRequired ? "  REVIEW REQUIRED" : ""}`,
    );
  } else {
    console.log(`ChatGPT Web:    unavailable (${chatgptWeb.error})`);
  }
  if (autoResume.ok) {
    console.log(
      `Auto Resume:    audited=${short(autoResume.auditedCommit)} latest=${short(autoResume.latestMain)}${autoResume.reviewRequired ? "  REVIEW REQUIRED" : ""}`,
    );
  } else {
    console.log(`Auto Resume:    unavailable (${autoResume.error})`);
  }
  console.log("");
  console.log("This command is read-only. It never merges, installs, or updates an upstream.");
}
