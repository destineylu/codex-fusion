import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(appRoot, "dist");

const bridgeSource = String.raw`
(() => {
  const calls = [];
  let navigationListener;
  const searchParams = new URLSearchParams(location.search);
  let usageDelayMs = Number(searchParams.get("usageDelayMs")) || 0;
  const snapshotDelayMs = Number(searchParams.get("snapshotDelayMs")) || 0;
  const providerDelayMs = Number(searchParams.get("providerDelayMs")) || 0;
  const accountDelay = searchParams.has("accountDelayMs")
    ? Number(searchParams.get("accountDelayMs")) || 0
    : null;
  const providerUsageDelay = searchParams.has("providerUsageDelayMs")
    ? Number(searchParams.get("providerUsageDelayMs")) || 0
    : null;
  const rejectAccountUsageAfter = Number(searchParams.get("rejectAccountUsageAfter")) || 0;
  let rejectAccountUsageOnce = searchParams.get("rejectAccountUsageOnce") === "1";
  const staleProviderUsage = searchParams.get("staleProviderUsage") === "1";
  const pollOnceMs = Number(searchParams.get("pollOnceMs")) || 0;
  const antigravityFixture = searchParams.get("antigravityFixture") === "1";
  let accountUsageReads = 0;
  let providerUsageReads = 0;
  if (pollOnceMs > 0) {
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => delay === 5 * 60_000
      ? window.setTimeout(callback, pollOnceMs, ...args)
      : nativeSetInterval(callback, delay, ...args);
  }
  const subagents = { mode: "all", enabled: [], disabled: [], efforts: {}, proofs: {} };
  const selectedModel = {
    slug: "deepseek/deepseek-chat",
    displayName: "DeepSeek Chat",
    description: "Selected route used by the renderer fixture.",
    provider: "deepseek",
    enabled: true,
    visible: true,
    multiAgentVersion: "v1",
    subagentCertification: "v1",
    reasoningLevels: ["low", "medium", "high"],
    contextWindow: 128000,
    inputModalities: ["text"],
  };
  const oxProviders = [
    { id: "commandcode", displayName: "Command Code", kind: "api", configured: false },
    { id: "nousresearch", displayName: "Nous Research", kind: "api", configured: false },
    { id: "opencode-free", displayName: "OpenCode Free", kind: "anonymous", configured: true },
    { id: "opencode-go", displayName: "opencode Go/Zen", kind: "api", configured: true },
    { id: "openrouter", displayName: "OpenRouter", kind: "api", configured: false },
    { id: "venice", displayName: "Venice", kind: "api", configured: false },
  ];
  const knownOxModels = oxProviders.map((provider) => ({
    slug: provider.id + "/ox-alpha",
    displayName: "Ox Alpha (" + provider.displayName + ")",
    provider: provider.id,
    available: provider.id === "opencode-free" || provider.id === "opencode-go",
    contextWindow: 1048576,
    inputModalities: ["text", "image"],
    isFree: true,
  }));
  const activeOxModels = knownOxModels.filter((model) => model.available).map((model) => ({
    ...model,
    enabled: true,
    visible: false,
    multiAgentVersion: "v1",
    subagentCertification: "unknown",
  }));
  const antigravityKnownModel = {
    slug: "antigravity-oauth/gemini-3.1-pro",
    displayName: "Gemini 3.1 Pro",
    provider: "antigravity-oauth",
    available: false,
    contextWindow: 1048576,
    inputModalities: ["text", "image"],
  };
  const target = {
    target: "codex",
    configured: true,
    active: true,
    enabledProviders: ["deepseek", "opencode-free", "opencode-go"],
    providers: [
      { id: "deepseek", displayName: "DeepSeek", kind: "api" },
      { id: "kilo-free", displayName: "Kilo Free", kind: "anonymous" },
      ...oxProviders.map(({ id, displayName, kind }) => ({ id, displayName, kind })),
      ...(antigravityFixture ? [{ id: "antigravity-oauth", displayName: "Google Antigravity OAuth", kind: "oauth" }] : []),
    ],
    models: [selectedModel, ...activeOxModels],
    modelSettings: {
      subagents,
      picker: { hidden: [], visible: [selectedModel.slug], hasExplicitVisibility: true },
      localModels: {},
      visionBridge: { enabled: false },
    },
  };
  const snapshot = {
    targets: { codex: target },
    catalog: {
      source: "codex-router",
      configured: true,
      enabledProviders: ["deepseek", "opencode-free", "opencode-go"],
      models: [selectedModel, ...activeOxModels],
      knownModels: [
        ...knownOxModels,
        ...(antigravityFixture ? [antigravityKnownModel] : []),
      ],
      picker: { hidden: [], visible: [selectedModel.slug], hasExplicitVisibility: true },
      subagents,
    },
    chatgptSession: { sharing: "disabled", session: "unavailable", present: false },
  };
  const providers = {
    providers: [
      {
        id: "deepseek",
        displayName: "DeepSeek",
        kind: "api",
        configured: true,
        action: "ready",
        credentialLabel: "DeepSeek API key",
        catalogSources: [{ id: "deepseek", displayName: "DeepSeek", kind: "models-endpoint" }],
      },
      {
        id: "kilo-free",
        displayName: "Kilo Free",
        kind: "anonymous",
        configured: true,
        action: "anonymous",
        credentialLabel: "No API key",
        catalogSources: [{ id: "kilo-free", displayName: "Kilo Free", kind: "models-endpoint" }],
      },
      ...oxProviders.map((provider) => ({
        ...provider,
        action: provider.configured ? "ready" : "provider-key",
        credentialLabel: provider.kind === "anonymous" ? "No API key" : provider.displayName + " API key",
        ...(provider.id === "opencode-go" ? {
          catalogSources: [{ id: "opencode-go", displayName: "opencode Go/Zen", kind: "models-endpoint" }],
        } : {}),
      })),
      ...(antigravityFixture ? [{
        id: "antigravity-oauth",
        displayName: "Google Antigravity OAuth",
        kind: "oauth",
        configured: false,
        clientSecretConfigured: false,
        clientSecretPersisted: false,
        action: "login",
        credentialLabel: "OAuth session",
      }] : []),
    ],
  };

  const record = (name, ...args) => calls.push({ name, args });
  let codexSkillMode = "light";
  let codexTemporarySkills = new Set();
  let codexAutoResumeAutostart = false;
  let codexAutoResumeResetCredit = false;
  const codexAutoResumeSnapshot = (report) => {
    const active = codexAccountProfiles?.find?.((profile) => profile.active);
    return {
      supported: true,
      installed: true,
      root: "C:/Users/test/AppData/Local/codex-router-sidecars/codex-auto-resume",
      stateDir: "C:/Users/test/AppData/Local/vibcoding/codex-auto-resume/accounts/" + (active?.identityFingerprint || "unbound"),
      repository: "https://github.com/feifeigong/codex-auto-resume.git",
      version: "0.2.2",
      running: codexAutoResumeAutostart,
      autostart: codexAutoResumeAutostart,
      autoRedeemWeeklyReset: codexAutoResumeResetCredit,
      accountFingerprint: active?.identityFingerprint,
      accountLabel: active?.label,
      accountGuarded: Boolean(active?.identityFingerprint),
      unboundThreads: 1,
      mismatchedThreads: 0,
      lastStatus: "waiting-primary-reset",
      trackedThreads: 2,
      activeThreads: 1,
      threads: [
        {
          threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          enabled: true,
          status: "waiting",
          resumes: 0,
          accountFingerprint: active?.identityFingerprint,
          accountLabel: active?.label,
          accountBinding: "current",
        },
        {
          threadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          enabled: false,
          status: "account-unbound",
          resumes: 0,
          accountBinding: "unbound",
        },
      ],
      ...(report ? { report } : {}),
    };
  };
  const codexChatGptWebSnapshot = (report) => ({
    supported: true,
    installed: true,
    repository: "https://github.com/miuuyy/codex-chatgpt-web",
    auditedVersion: "5.0.8",
    providerId: "chatgpt-web",
    launcherPath: "C:/Users/test/AppData/Local/Programs/Codex Web GPT/Codex Web GPT.exe",
    home: "C:/Users/test/AppData/Local/codex-router-sidecars/codex-chatgpt-web",
    shadowCodexHome: "C:/Users/test/AppData/Local/codex-router-sidecars/codex-chatgpt-web/codex-home",
    launcherDataDir: "C:/Users/test/AppData/Local/codex-router-sidecars/codex-chatgpt-web/launcher",
    running: true,
    daemonRunning: true,
    bridgeReachable: true,
    daemonEndpoint: "http://127.0.0.1:17841/v1",
    supervisorStatus: "ready",
    browserReady: true,
    onboardingComplete: true,
    browserSmokePassed: true,
    configured: true,
    daemonOwner: "router",
    routeOwner: "router",
    routeDisplay: "Codex Router (loopback, capability path redacted)",
    directRouteConflict: false,
    safeToDiscover: true,
    upstreamExternalProviderSupported: false,
    ...(report ? { report } : {}),
  });
  let codexLoginSession;
  let codexAccountProfiles = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      label: "主账号",
      active: true,
      markedActive: true,
      liveMatches: true,
      usable: true,
      expired: false,
      identityFingerprint: "aaaabbbbcccc",
      expiresInHours: 48,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      label: "备用账号",
      active: false,
      markedActive: false,
      liveMatches: false,
      usable: true,
      expired: false,
      identityFingerprint: "ddddeeeeffff",
      expiresInHours: 36,
    },
  ];
  const codexAccountsSnapshot = (report) => ({
    supported: true,
    root: "C:/Users/test/.codex/codex-router/native-accounts",
    profiles: codexAccountProfiles.map((profile) => ({ ...profile })),
    activeAccountId: codexAccountProfiles.find((profile) => profile.active)?.id,
    markedActiveAccountId: codexAccountProfiles.find((profile) => profile.markedActive)?.id,
    liveAuthPresent: true,
    liveManaged: true,
    desktopRunning: false,
    routerRestartRequired: false,
    configMutationRequired: false,
    ...(codexLoginSession ? { loginSession: { ...codexLoginSession } } : {}),
    ...(report ? { report } : {}),
  });
  const codexSkillSnapshot = () => {
    const specialized = ["comfyui", "xiaohongshu-box"].map((name) => ({
      name,
      source: name === "comfyui" ? "~/.codex/skills/comfyui-skill/SKILL.md" : "~/.codex/skills/xiaohongshu-box/SKILL.md",
      path: "C:/Users/test/.codex/skills/" + name + "/SKILL.md",
      description: name === "comfyui" ? "Generate images, video, and audio with ComfyUI." : "Generate social card image sets and WeChat covers.",
      category: "specialized",
      state: codexSkillMode === "full" ? "FULL" : codexTemporarySkills.has(name) ? "TEMP ON" : "OFF",
      enabled: codexSkillMode === "full" || codexTemporarySkills.has(name),
      temporary: codexSkillMode === "light" && codexTemporarySkills.has(name),
      estimatedPromptTokens: codexSkillMode === "full" || codexTemporarySkills.has(name) ? 64 : 0,
      estimatedEnabledPromptTokens: 64,
    }));
    const skills = [
      {
        name: "code",
        source: "~/.agents/skills/code-1.0.4/SKILL.md",
        description: "Coding workflow with planning, implementation, verification, and testing.",
        category: "core",
        state: "On",
        enabled: true,
        temporary: false,
        estimatedPromptTokens: 48,
        estimatedEnabledPromptTokens: 48,
      },
      ...specialized,
      {
        name: "test-runner",
        source: "~/.agents/skills/test-runner-1.0.0/SKILL.md",
        description: "",
        category: "invalid",
        state: "Invalid",
        enabled: false,
        temporary: false,
        estimatedPromptTokens: 0,
        estimatedEnabledPromptTokens: 0,
        validationMessage: "Missing YAML frontmatter",
      },
      {
        name: "visualize",
        source: "~/.codex/plugins/cache/openai-bundled/visualize/SKILL.md",
        description: "Visualize data and content.",
        category: "plugin-cache",
        state: "Active plugin",
        enabled: true,
        temporary: false,
        estimatedPromptTokens: 40,
        estimatedEnabledPromptTokens: 40,
      },
    ];
    return {
      supported: true,
      scriptPath: "~/.codex/switch-codex-mode.ps1",
      defaultMode: "light",
      mode: codexSkillMode,
      modeLabel: codexSkillMode === "light" ? "LIGHT v2" : "FULL",
      model: "commandcode/deepseek-v4-flash",
      temporaryExceptions: codexTemporarySkills.size,
      disabledEntries: codexSkillMode === "light" ? 2 - codexTemporarySkills.size : 0,
      specializedCandidates: 2,
      coreSkills: 1,
      specializedSkills: 2,
      invalidSkills: 1,
      pluginCacheSkills: 1,
      estimatedPromptTokens: skills.reduce((sum, skill) => sum + skill.estimatedPromptTokens, 0),
      skills,
    };
  };
  const catalog = (providerId) => {
    record("discoverProviderModels", providerId);
    if (providerId === "kilo-free") {
      return {
        provider: providerId,
        discovered: ["kilo-unselected-free"],
        registered: [],
        unregistered: ["kilo-unselected-free"],
        addable: ["kilo-unselected-free"],
        blocked: {},
        unavailable: [],
        free: ["kilo-unselected-free"],
      };
    }
    return {
      provider: providerId,
      discovered: ["catalog-addable", "blocked-preview"],
      registered: [],
      unregistered: ["catalog-addable", "blocked-preview"],
      addable: ["catalog-addable"],
      blocked: { "blocked-preview": "No certified protocol route is available." },
      unavailable: [],
      contextLengths: { "catalog-addable": 200000, "blocked-preview": 128000 },
      fetchedAt: "2026-08-24T00:00:00.000Z",
    };
  };

  window.routerControl = Object.freeze({
    platform: navigator.platform.toLowerCase().includes("mac") ? "darwin" : "linux",
    getSnapshot: async () => {
      await new Promise((resolve) => setTimeout(resolve, snapshotDelayMs));
      return snapshot;
    },
    getProviders: async () => {
      await new Promise((resolve) => setTimeout(resolve, providerDelayMs));
      return providers;
    },
    getPresence: async () => ({ mode: "always" }),
    getHealth: async () => ({ ok: true, activity: { state: "idle", active: [], activeCount: 0 } }),
    getHarnesses: async () => ({
      platform: "win32",
      terminalAvailable: false,
      harnesses: [{
        id: "codex",
        displayName: "Codex",
        ownership: "openai",
        description: "OpenAI's desktop and terminal coding harness.",
        cliInstalled: true,
        cliVersion: "codex-cli 0.153.0-alpha.5",
        appInstalled: true,
        configured: true,
        canInstall: false,
        docsUrl: "https://developers.openai.com/codex/cli/",
      }],
    }),
    getCodexSkillControl: async () => codexSkillSnapshot(),
    getCodexAutoResume: async () => codexAutoResumeSnapshot(),
    getCodexChatGptWeb: async () => codexChatGptWebSnapshot(),
    getCodexAccounts: async () => codexAccountsSnapshot(),
    getContextSessions: async () => ({
      fetchedAt: "2026-09-22T00:00:00.000Z",
      counts: { total: 1, codex: 1, deepcode: 0, archived: 0 },
      sessions: [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        harnessId: "codex",
        title: "未完成的 Native GPT 任务",
        updatedAt: "2026-09-22T00:00:00.000Z",
        workspace: "C:/work/project-a",
        workspaceLabel: "project-a",
        model: "gpt-5.6-luna",
        archived: false,
        resumable: true,
        status: "saved",
      }],
    }),
    getAccountUsage: async () => {
      accountUsageReads += 1;
      await new Promise((resolve) => setTimeout(resolve, accountDelay ?? usageDelayMs));
      if (rejectAccountUsageOnce) {
        rejectAccountUsageOnce = false;
        throw new Error("Error invoking remote method 'router-control:getAccountUsage': Error: Codex account usage request timed out.\\n    at fakeElectronBoundary");
      }
      if (rejectAccountUsageAfter && accountUsageReads >= rejectAccountUsageAfter) {
        throw new Error("Account usage poll failed");
      }
      return {
        fetchedAt: "2026-08-27T08:00:00.000Z",
        planType: "pro",
        primary: {
          usedPercent: 34,
          remainingPercent: 66,
          windowDurationMins: 300,
          resetsAt: 1800000000,
        },
        dailyUsageBuckets: [{ startDate: "2026-08-27", tokens: 24000 }],
        summary: { lifetimeTokens: 24000, peakDailyTokens: 24000, currentStreakDays: 1 },
      };
    },
    getProviderUsage: async () => {
      providerUsageReads += 1;
      const read = providerUsageReads;
      await new Promise((resolve) => setTimeout(
        resolve,
        staleProviderUsage && read > 1 ? 0 : providerUsageDelay ?? usageDelayMs,
      ));
      const totalTokens = staleProviderUsage && read > 1 ? 24000 : 12000;
      const spendWindow = {
        key: "weekly",
        label: "Current 7 days",
        from: "2026-08-20T08:00:00.000Z",
        to: "2026-08-27T08:00:00.000Z",
        usageValueUsd: 0.25,
        goatCredits: 0.5,
        requests: 2,
        pricedRequests: 2,
        incompleteRequests: 0,
        retrospectiveRequests: 0,
        unpricedRequests: 0,
        models: [{
          slug: "commandcode/meta/muse-spark-1.3-contributor",
          displayName: "Muse Spark 1.3 Contributor",
          usageValueUsd: 0.25,
          goatCredits: 0.5,
          requests: 2,
          pricedRequests: 2,
          incompleteRequests: 0,
          retrospectiveRequests: 0,
          unpricedRequests: 0,
          inputTokens: 1000,
          cachedInputTokens: 800,
          outputTokens: 200,
          cacheHitPercent: 80,
          goatMonthlyAllowance: 20,
          goatMultiplier: 3.5,
        }],
      };
      const xkiroSpendWindow = {
        key: "weekly",
        label: "Current 7 days",
        from: "2026-08-20T08:00:00.000Z",
        to: "2026-08-27T08:00:00.000Z",
        usageValueUsd: 1.75,
        requests: 3,
        pricedRequests: 3,
        incompleteRequests: 1,
        retrospectiveRequests: 0,
        unpricedRequests: 0,
        models: [{
          slug: "xkiro2/anthropic/claude-fable-5-1",
          displayName: "Claude Fable 5.1",
          accessTier: "paid",
          usageValueUsd: 1.75,
          requests: 3,
          pricedRequests: 3,
          incompleteRequests: 1,
          retrospectiveRequests: 0,
          unpricedRequests: 0,
          inputTokens: 600000,
          cachedInputTokens: 570000,
          outputTokens: 1500,
          cacheHitPercent: 95,
        }],
      };
      return {
        fetchedAt: "2026-08-27T08:00:00.000Z",
        commandCodeSpend: {
          pricingVersion: "goat-test",
          pricingSource: "https://commandcode.ai/docs/plans/goat",
          goatMonthlyCredits: 70,
          observedFrom: "2026-08-27T07:00:00.000Z",
          capturedFrom: "2026-08-27T07:00:00.000Z",
          plan: "GOAT",
          recentRequests: [{
            at: "2026-08-27T07:59:30.000Z",
            slug: "commandcode/meta/muse-spark-1.3-contributor",
            displayName: "Muse Spark 1.3 Contributor",
            status: 200,
            durationMs: 8_400,
            inputTokens: 0,
            outputTokens: 173,
            estimatedInputTokens: 175_840,
            usageValueUsd: 0.0000346,
            goatCredits: 0.0001211,
            complete: false,
            retrospective: false,
          }],
          windows: {
            fiveHour: { ...spendWindow, key: "fiveHour", label: "Current 5 hours" },
            weekly: spendWindow,
            thirtyDay: { ...spendWindow, key: "thirtyDay", label: "Last 30 days" },
            all: { ...spendWindow, key: "all", label: "All tracked", from: null },
          },
        },
        xkiroSpend: {
          xkiro2: {
            providerId: "xkiro2",
            pricingVersion: "models-test",
            pricingSource: "https://api.xkiro.com/v1/models",
            observedFrom: "2026-08-27T07:00:00.000Z",
            capturedFrom: "2026-08-27T07:00:00.000Z",
            plan: "ultra",
            recentRequests: [{
              at: "2026-08-27T07:59:45.000Z",
              slug: "xkiro2/anthropic/claude-fable-5-1",
              displayName: "Claude Fable 5.1",
              status: 200,
              durationMs: 12_500,
              inputTokens: 204_000,
              cachedInputTokens: 200_000,
              outputTokens: 240,
              usageValueUsd: 0.08,
              complete: true,
              retrospective: false,
            }],
            windows: {
              fiveHour: { ...xkiroSpendWindow, key: "fiveHour", label: "Current 5 hours" },
              weekly: xkiroSpendWindow,
              thirtyDay: { ...xkiroSpendWindow, key: "thirtyDay", label: "Last 30 days" },
              all: { ...xkiroSpendWindow, key: "all", label: "All tracked", from: null },
            },
          },
        },
        providers: [{
          id: "xkiro2",
          displayName: "Xkiro API #2",
          credentialType: "api",
          totalTokens: 612000,
          requests: 3,
          last24hTokens: 612000,
          last24hRequests: 3,
          dailyUsageBuckets: [{ startDate: "2026-08-27", tokens: 612000, requests: 3 }],
          account: {
            status: "available",
            plan: "ultra",
            dashboardUrl: "https://xkiro.com",
            metrics: [
              {
                kind: "quota",
                label: "5-hour limit",
                used: 14,
                limit: 200,
                remaining: 186,
                usedPercent: 7,
                remainingPercent: 93,
                unit: "USD",
                resetAt: 1800000000,
              },
              {
                kind: "quota",
                label: "7-day limit",
                used: 62,
                limit: 1320,
                remaining: 1258,
                usedPercent: 4.7,
                remainingPercent: 95.3,
                unit: "USD",
                resetAt: 1800500000,
              },
              {
                kind: "quota",
                label: "Daily free tokens",
                used: 26676,
                limit: 300000000,
                remaining: 299973324,
                usedPercent: 0.01,
                remainingPercent: 99.99,
                unit: "tokens",
              },
              { kind: "balance", label: "Wallet balance", value: 0, currency: "USD", detail: "Available wallet balance" },
            ],
            xkiroHistory: {
              period: "month",
              bucket: "day",
              points: [{ ts: "2026-08-27T00:00:00.000Z", requests: 3, tokens: 612000, spendUsd: 2.04 }],
              total: { requests: 433, tokens: 98693833, spendUsd: 61.24 },
            },
          },
        }, {
          id: "commandcode",
          displayName: "Command Code",
          credentialType: "api",
          totalTokens: 175_840,
          requests: 1,
          last24hTokens: 175_840,
          last24hRequests: 1,
          dailyUsageBuckets: [{ startDate: "2026-08-27", tokens: 175_840, requests: 1 }],
          account: {
            status: "available",
            plan: "GOAT",
            dashboardUrl: "https://commandcode.ai",
            metrics: [
              { kind: "quota", label: "5-hour limit", used: 2, limit: 15, remaining: 13, usedPercent: 13.3, remainingPercent: 86.7, unit: "credits", resetAt: 1800000000 },
              { kind: "quota", label: "Weekly limit", used: 12.77, limit: 35, remaining: 22.23, usedPercent: 36.5, remainingPercent: 63.5, unit: "credits", resetAt: 1800500000 },
              { kind: "quota", label: "Monthly plan usage", used: 34, limit: 70, remaining: 36, usedPercent: 48.6, remainingPercent: 51.4, unit: "credits" },
              { kind: "balance", label: "Plan credits", value: 36, detail: "GOAT plan credits" },
            ],
          },
        }, {
          id: "deepseek",
          displayName: "DeepSeek",
          credentialType: "api",
          totalTokens,
          requests: 8,
          last24hTokens: totalTokens,
          last24hRequests: 8,
          dailyUsageBuckets: [{ startDate: "2026-08-27", tokens: totalTokens, requests: 8 }],
          account: {
            status: "available",
            metrics: [
              {
                kind: "quota",
                label: "Monthly credits",
                usedPercent: 25,
                remainingPercent: 75,
                resetAt: 1800000000,
              },
              {
                kind: "quota",
                label: "Rolling window",
                usedPercent: 40,
                remainingPercent: 60,
                resetAt: 1790000000,
              },
            ],
          },
        }],
      };
    },
    discoverProviderModels: async (providerId) => catalog(providerId),
    addProviderModels: async (providerId, modelIds) => {
      record("addProviderModels", providerId, [...modelIds]);
      return { ok: true };
    },
    verifyProviderModel: async (providerId, modelId) => {
      record("verifyProviderModel", providerId, modelId);
      return {
        provider: providerId,
        model: modelId,
        safeToCurate: true,
        selectedRoute: providerId,
        applied: { entry: { slug: providerId + "/" + modelId } },
      };
    },
    setPickerModels: async (showAll) => {
      record("setPickerModels", showAll);
      return { ok: true };
    },
    setPickerModel: async () => ({ ok: true }),
    setProviderEnabled: async () => ({ ok: true }),
    controlTray: async () => ({ status: { supported: true } }),
    controlCodexAutoResume: async (action) => {
      record("controlCodexAutoResume", action);
      if (action === "enable-autostart") codexAutoResumeAutostart = true;
      if (action === "disable-autostart") codexAutoResumeAutostart = false;
      if (action === "enable-reset-credit") codexAutoResumeResetCredit = true;
      if (action === "disable-reset-credit") codexAutoResumeResetCredit = false;
      return codexAutoResumeSnapshot(action === "doctor" ? "app_server OK ok" : action === "dry-run" ? "dry-run waiting=0" : undefined);
    },
    bindCodexAutoResumeThread: async (threadId) => {
      record("bindCodexAutoResumeThread", threadId);
      return codexAutoResumeSnapshot("Thread bound to current native account.");
    },
    controlCodexChatGptWeb: async (action) => {
      record("controlCodexChatGptWeb", action);
      return codexChatGptWebSnapshot(
        action === "verify-isolation"
          ? "Isolation verified: Codex still routes through Router and the ChatGPT Web bridge is reachable on loopback."
          : undefined,
      );
    },
    addCodexAccount: async (label) => {
      record("addCodexAccount", label);
      codexAccountProfiles = [
        ...codexAccountProfiles,
        {
          id: "33333333-3333-4333-8333-333333333333",
          label,
          active: false,
          markedActive: false,
          liveMatches: false,
          usable: true,
          expired: false,
          identityFingerprint: "111122223333",
          expiresInHours: 72,
        },
      ];
      return codexAccountsSnapshot("账号已通过官方 Codex 登录保存。当前活动账号未改变，Router 未重启。");
    },
    startCodexAccountBrowserLogin: async (label) => {
      record("startCodexAccountBrowserLogin", label);
      codexLoginSession = {
        id: "44444444-4444-4444-8444-444444444444",
        label,
        mode: "browser",
        status: "waiting",
        startedAt: "2026-09-20T10:00:00.000Z",
        authorizationUrl: "https://auth.openai.com/oauth/authorize?client_id=test&state=state-123",
      };
      return codexAccountsSnapshot("官方 Codex 浏览器 OAuth 已启动。");
    },
    startCodexAccountDeviceLogin: async (label) => {
      record("startCodexAccountDeviceLogin", label);
      codexLoginSession = {
        id: "55555555-5555-4555-8555-555555555555",
        label,
        mode: "device",
        status: "waiting",
        startedAt: "2026-09-20T10:00:00.000Z",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "CODE-12345",
      };
      return codexAccountsSnapshot("设备代码登录已启动。请在无痕窗口打开登录地址并输入一次性代码；Router 保持运行。");
    },
    submitCodexAccountCallback: async (callbackUrl) => {
      record("submitCodexAccountCallback", callbackUrl);
      if (codexLoginSession) {
        codexLoginSession = {
          ...codexLoginSession,
          callbackSubmittedAt: "2026-09-20T10:01:00.000Z",
          report: "localhost 回调已转交给官方 Codex 登录进程，正在等待认证文件写入。",
        };
      }
      return codexAccountsSnapshot("localhost 回调已转交给官方 Codex 登录进程，正在等待认证文件写入。");
    },
    cancelCodexAccountLogin: async () => {
      record("cancelCodexAccountLogin");
      codexLoginSession = undefined;
      return codexAccountsSnapshot("ChatGPT 登录会话已关闭；当前 Codex 账号和 Router 均未改变。");
    },
    renameCodexAccount: async (id, label) => {
      record("renameCodexAccount", id, label);
      codexAccountProfiles = codexAccountProfiles.map((profile) => profile.id === id ? { ...profile, label } : profile);
      return codexAccountsSnapshot("账号名称已更新；认证身份和 Router 配置均未改变。");
    },
    switchCodexAccount: async (id, options) => {
      record("switchCodexAccount", id, options);
      codexAccountProfiles = codexAccountProfiles.map((profile) => ({
        ...profile,
        active: profile.id === id,
        markedActive: profile.id === id,
        liveMatches: profile.id === id,
      }));
      return {
        ...codexAccountsSnapshot(options?.handoffThreadId
          ? "账号已切换并已准备同一 Native GPT thread 接力。Router 全程保持运行。"
          : "账号已切换。Router 全程保持运行；请重新打开 Codex Desktop 使用新账号。"),
        ...(options?.handoffThreadId
          ? { handoffThreadId: options.handoffThreadId, handoffPrepared: true }
          : {}),
      };
    },
    deleteCodexAccount: async (id) => {
      record("deleteCodexAccount", id);
      codexAccountProfiles = codexAccountProfiles.filter((profile) => profile.id !== id);
      return codexAccountsSnapshot("账号 Profile 已删除；当前 Codex 登录和 Router 均未改变。");
    },
    setCodexContextMode: async (mode) => {
      record("setCodexContextMode", mode);
      codexSkillMode = mode;
      if (mode === "light") codexTemporarySkills = new Set();
      return codexSkillSnapshot();
    },
    setCodexSkillException: async (skillName, enabled) => {
      record("setCodexSkillException", skillName, enabled);
      if (enabled) codexTemporarySkills.add(skillName);
      else codexTemporarySkills.delete(skillName);
      return codexSkillSnapshot();
    },
    setSubagentModel: async () => ({ ok: true }),
    setSubagentEffort: async () => ({ ok: true }),
    onNavigation: (listener) => {
      navigationListener = listener;
      return () => { if (navigationListener === listener) navigationListener = undefined; };
    },
    onOperation: () => () => {},
  });
  window.routerControlTest = Object.freeze({
    calls: () => calls.map((call) => ({ name: call.name, args: call.args })),
    navigationReady: () => Boolean(navigationListener),
    navigate: (destination) => {
      if (!navigationListener) return false;
      navigationListener(destination);
      return true;
    },
    setUsageDelay: (milliseconds) => { usageDelayMs = milliseconds; },
    usageReads: () => ({ account: accountUsageReads, provider: providerUsageReads }),
  });
})();
`;

function mimeType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function serveRenderer() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (pathname === "/test-bridge.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(bridgeSource);
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(dist, relative);
    if (target !== dist && !target.startsWith(`${dist}${path.sep}`) || !existsSync(target)) {
      response.writeHead(404).end("not found");
      return;
    }
    let contents = readFileSync(target);
    if (relative === "index.html") {
      const html = contents.toString("utf8");
      assert.match(html, /<script type="module"/);
      contents = Buffer.from(
        html.replace('<script type="module"', '<script src="./test-bridge.js"></script><script type="module"'),
      );
    }
    response.writeHead(200, { "content-type": mimeType(target) });
    response.end(contents);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((done) => {
          server.close(done);
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

const chromiumPath = [
  process.env.CODEX_ROUTER_TEST_CHROMIUM,
  chromium.executablePath(),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
].find((candidate) => candidate && existsSync(candidate));

test("the production renderer exposes model discovery and picker actions", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 }, locale: "en-US" });
    // Windows hosted runners routinely spend about 30 seconds starting the
    // browser. Keep UI waits short and diagnostic without letting that startup
    // consume the whole integration-test deadline.
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("navigation", { name: "Control center sections" }).waitFor();
    const wordmark = page.locator(".router-wordmark");
    assert.equal((await wordmark.locator("strong").innerText()).trim(), "Codex Fusion");
    assert.equal(await wordmark.locator("img").count(), 0);
    await page.waitForFunction(() => window.routerControlTest.navigationReady());
    await page.evaluate(() => window.routerControlTest.setUsageDelay(600));
    assert.equal(
      await page.evaluate(() => window.routerControlTest.navigate({ destination: "usage", sourceId: "deepseek" })),
      true,
    );
    await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
    const allowancePanel = page.getByLabel("Accounts and allowances");
    const accountTabs = allowancePanel.getByRole("tablist", { name: "Account provider" });
    assert.equal(await accountTabs.getByRole("tab").count(), 4);
    assert.equal(await page.getByLabel("Command Code model spend").count(), 0);
    assert.equal(await page.getByLabel("Xkiro account usage").count(), 0);

    await accountTabs.getByRole("tab", { name: /Xkiro API #2/ }).click();
    assert.equal(await allowancePanel.locator(".us-metric-card").count(), 4);
    assert.match(await allowancePanel.innerText(), /Daily free tokens/);
    assert.doesNotMatch(await allowancePanel.innerText(), /Monthly credits/);
    await page.getByRole("heading", { name: "Xkiro account usage", exact: true }).waitFor();
    assert.equal(await page.getByLabel("Command Code model spend").count(), 0);

    await accountTabs.getByRole("tab", { name: /DeepSeek/ }).click();
    assert.equal(await allowancePanel.locator(".us-metric-card").count(), 2);
    assert.match(await allowancePanel.innerText(), /Monthly credits/);
    assert.doesNotMatch(await allowancePanel.innerText(), /Daily free tokens/);
    assert.equal(await page.getByLabel("Command Code model spend").count(), 0);
    assert.equal(await page.getByLabel("Xkiro account usage").count(), 0);

    await accountTabs.getByRole("tab", { name: /Command Code/ }).click();
    await page.getByRole("heading", { name: "Command Code model spend", exact: true }).waitFor();
    const commandSpendPanel = page.getByLabel("Command Code model spend");
    assert.equal(await page.getByLabel("Xkiro account usage").count(), 0);
    assert.match(await commandSpendPanel.innerText(), /Muse Spark 1\.3 Contributor/);
    assert.match(await commandSpendPanel.innerText(), /GOAT credit eq\./i);
    assert.match(await commandSpendPanel.innerText(), /7-day remaining/i);
    assert.doesNotMatch(await commandSpendPanel.innerText(), /5-hour remaining/i);
    assert.match(await commandSpendPanel.innerText(), /Recent Command Code requests/);
    assert.match(await commandSpendPanel.innerText(), /provider omitted · router est\./);
    await commandSpendPanel.getByRole("button", { name: "5 hours" }).click();
    assert.match(await commandSpendPanel.innerText(), /5-hour remaining/i);
    assert.doesNotMatch(await commandSpendPanel.innerText(), /7-day remaining/i);
    await commandSpendPanel.getByRole("button", { name: "30 days" }).click();
    assert.match(await commandSpendPanel.innerText(), /Official monthly used/i);
    assert.doesNotMatch(await commandSpendPanel.innerText(), /5-hour remaining|7-day remaining/i);

    await accountTabs.getByRole("tab", { name: /Xkiro API #2/ }).click();
    await page.getByRole("heading", { name: "Xkiro account usage", exact: true }).waitFor();
    const xkiroPanel = page.getByLabel("Xkiro account usage");
    assert.equal(await page.getByLabel("Command Code model spend").count(), 0);
    assert.match(await xkiroPanel.innerText(), /ultra/i);
    assert.match(await xkiroPanel.innerText(), /Claude Fable 5\.1/);
    assert.match(await xkiroPanel.innerText(), /7-day remaining/i);
    assert.doesNotMatch(await xkiroPanel.innerText(), /5-hour remaining|Official 30-day/i);
    assert.match(await xkiroPanel.innerText(), /Recent Xkiro requests/i);
    assert.match(await xkiroPanel.innerText(), /300m/i);
    assert.match(await xkiroPanel.innerText(), /Wallet/i);
    await xkiroPanel.getByRole("button", { name: "30 days" }).click();
    assert.match(await xkiroPanel.innerText(), /Official 30-day/i);
    assert.match(await xkiroPanel.innerText(), /\$61\.24/);
    assert.doesNotMatch(await xkiroPanel.innerText(), /5-hour remaining|7-day remaining/i);
    assert.equal(
      await page.evaluate(() => window.routerControlTest.navigate({ destination: "usage-resets", sourceId: "deepseek" })),
      true,
    );
    await page.waitForFunction(() => {
      const active = document.activeElement;
      return active?.classList.contains("us-metric-card")
        && active.getAttribute("aria-label")?.startsWith("DeepSeek, Rolling window");
    });
    assert.match(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      /DeepSeek, Rolling window.*Resets/,
    );
    assert.equal(
      await page.evaluate(() => window.routerControlTest.navigate({ destination: "usage", sourceId: "openai" })),
      true,
    );
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Usage overview");
    assert.equal(await page.getByLabel("Usage source").inputValue(), "chatgpt-subscription");
    await page.getByRole("button", { name: "Models", exact: true }).click();

    // The connections strip carries every account: connected providers as
    // chips, the rest behind one menu.
    const connections = page.locator(".pm-connections");
    await connections.waitFor();
    assert.match(await connections.innerText(), /3 of 8 connected/);
    assert.deepEqual(
      (await connections.locator(".pm-chip:not(.pm-chip-add)").allTextContents()).map((text) => text.trim()).sort(),
      ["DeepSeek", "OpenCode Free", "opencode Go/Zen"].sort(),
    );
    await connections.getByRole("button", { name: "Connect provider", exact: true }).click();
    const connectMenu = page.locator(".pm-connect-menu");
    await connectMenu.waitFor();
    // An anonymous endpoint is not connected until it is explicitly enabled,
    // so it belongs with the providers still waiting for a connection.
    assert.match(await connectMenu.innerText(), /Kilo Free/);
    assert.equal(await connectMenu.getByRole("menuitem").count(), 5);
    await page.keyboard.press("Escape");

    // A route that is only known to the registry still has to be findable. The
    // picker is provider-first, so overlapping model names appear inside their
    // provider sections instead of one six-provider family row.
    const modelSearch = page.locator('input[placeholder="Search models"]');
    await modelSearch.fill("Ox Alpha");
    const oxGroups = page.locator(".pm-picker-provider-group");
    await oxGroups.first().waitFor();
    assert.equal(await oxGroups.count(), 6);
    assert.deepEqual(
      (await oxGroups.locator(".pm-picker-provider-title strong").allTextContents()).sort(),
      ["Command Code", "Nous Research", "OpenCode Free", "opencode Go/Zen", "OpenRouter", "Venice"].sort(),
    );
    const openCodeFreeGroup = oxGroups.filter({ hasText: "OpenCode Free" });
    assert.equal(await openCodeFreeGroup.locator(".pm-family-row").count(), 1);
    assert.doesNotMatch(await openCodeFreeGroup.innerText(), /6 providers|6 routes/i);
    await openCodeFreeGroup.locator(".pm-family-open").click();
    assert.match(await openCodeFreeGroup.innerText(), /OpenCode Free · Provider API route|OpenCode Free · Free provider route/);
    await modelSearch.fill("");

    // Provider sections fold independently, and the preference is persisted
    // without mutating picker/provider state.
    const deepSeekGroup = page.locator('.pm-picker-provider-group[data-provider="deepseek"]');
    await deepSeekGroup.getByRole("button", { name: "Collapse DeepSeek models" }).click();
    assert.equal(await deepSeekGroup.locator(".pm-family-list").isHidden(), true);
    await page.waitForFunction(() =>
      (localStorage.getItem("codex-router.models.collapsed-providers.v1") || "").includes("deepseek"));
    assert.deepEqual(
      await page.evaluate(() => JSON.parse(localStorage.getItem("codex-router.models.collapsed-providers.v1") || "[]")),
      ["deepseek"],
    );
    await page.getByRole("button", { name: "Collapse all providers" }).click();
    assert.equal(
      await page.locator('.pm-picker-provider-group[data-collapsed="true"]').count(),
      await page.locator(".pm-picker-provider-group").count(),
    );
    await page.getByRole("button", { name: "Expand all providers" }).click();
    assert.equal(await page.locator('.pm-picker-provider-group[data-collapsed="true"]').count(), 0);

    // Adding is provider-first: opening the dialog must not fan out across every
    // connected account. The operator chooses the provider and explicitly
    // fetches only that catalog.
    await page.getByRole("button", { name: "Add models", exact: true }).click();
    const addDialog = page.locator(".pm-add-models");
    await addDialog.waitFor();
    assert.equal(
      await page.evaluate(() => window.routerControlTest.calls().filter((call) => call.name === "discoverProviderModels").length),
      0,
    );
    const providerTabs = addDialog.locator(".pm-add-models-provider-tab");
    assert.deepEqual(await providerTabs.locator("strong").allTextContents(), ["DeepSeek", "opencode Go/Zen"]);
    assert.deepEqual(await providerTabs.locator("small").allTextContents(), ["Not loaded", "Not loaded"]);

    await providerTabs.filter({ hasText: "opencode Go/Zen" }).click();
    await addDialog.getByRole("button", { name: "Fetch model list", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "discoverProviderModels" && call.args[0] === "opencode-go"));
    assert.deepEqual(
      await page.evaluate(() => window.routerControlTest.calls()
        .filter((call) => call.name === "discoverProviderModels")
        .map((call) => call.args[0])),
      ["opencode-go"],
    );

    await providerTabs.filter({ hasText: "DeepSeek" }).click();
    await addDialog.getByRole("button", { name: "Fetch model list", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "discoverProviderModels" && call.args[0] === "deepseek"));

    const blockedRow = addDialog.locator(".pm-add-models-row").filter({ hasText: "blocked-preview" });
    await blockedRow.waitFor();
    assert.equal(await blockedRow.getAttribute("data-blocked"), "true");
    assert.equal(await blockedRow.locator("input[type=checkbox]").isDisabled(), true);
    assert.equal(await blockedRow.getByRole("button", { name: "Verify & add", exact: true }).count(), 1);
    assert.equal(
      await blockedRow.locator(".pm-catalog-block-reason").innerText(),
      "No certified protocol route is available.",
    );
    await blockedRow.getByRole("button", { name: "Verify & add", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "verifyProviderModel"));

    // A compatible single model can be added directly without building a batch.
    const addableRow = addDialog.locator(".pm-add-models-row").filter({ hasText: "catalog-addable" });
    await addableRow.getByRole("button", { name: "Add", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "addProviderModels"));
    await addDialog.getByRole("button", { name: "Close", exact: true }).click();

    // Flipping a model must never move it. Sorting by the switch would throw
    // the row across the list at the moment the reader looks for confirmation.
    const modelNames = () => page.locator(".pm-family-main > strong").allTextContents();
    const orderBefore = await modelNames();
    assert.equal(orderBefore.includes("DeepSeek Chat"), true);
    assert.equal(orderBefore.filter((name) => name === "Ox Alpha").length, 6);
    const deepseekRow = page.locator(".pm-family-row").filter({ hasText: "DeepSeek Chat" });
    assert.equal((await deepseekRow.locator(".pm-family-state").innerText()).trim(), "On");
    await deepseekRow.locator('.pm-family-action input[type="checkbox"]').click();
    // Scope to the row's own state, not any "Off" inside its expanded panel.
    await deepseekRow.locator(".pm-family-state").filter({ hasText: "Off" }).waitFor();
    assert.deepEqual(await modelNames(), orderBefore);

    // Bulk switches live behind the overflow menu, off the main toolbar.
    await page.getByRole("button", { name: "More model actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Turn all on", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "setPickerModels" && call.args[0] === true));

    const calls = await page.evaluate(() => window.routerControlTest.calls());
    assert.deepEqual(calls.find((call) => call.name === "addProviderModels")?.args, [
      "deepseek",
      ["catalog-addable"],
    ]);
    assert.deepEqual(calls.find((call) => call.name === "verifyProviderModel")?.args, [
      "deepseek",
      "blocked-preview",
    ]);
    assert.equal(calls.some((call) => call.name === "setPickerModels" && call.args[0] === true), true);
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("provider folding persists across renderer reloads", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 }, locale: "en-US" });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Models", exact: true }).click();
    const deepSeekGroup = page.locator('.pm-picker-provider-group[data-provider="deepseek"]');
    await deepSeekGroup.waitFor();
    await deepSeekGroup.getByRole("button", { name: "Collapse DeepSeek models" }).click();
    await page.waitForFunction(() =>
      (localStorage.getItem("codex-router.models.collapsed-providers.v1") || "").includes("deepseek"));

    await page.reload({ waitUntil: "domcontentloaded" });
    const persistedGroup = page.locator('.pm-picker-provider-group[data-provider="deepseek"]');
    await persistedGroup.waitFor();
    assert.equal(await persistedGroup.getAttribute("data-collapsed"), "true");
    assert.equal(await persistedGroup.locator(".pm-family-list").isHidden(), true);
    assert.equal(await persistedGroup.getByRole("button", { name: "Expand DeepSeek models" }).count(), 1);
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("Antigravity model-row connect opens the client-secret dialog in place", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 }, locale: "en-US" });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?antigravityFixture=1`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await page.getByRole("heading", { name: "Models", exact: true }).waitFor();
    const antigravityRow = page.locator(".pm-family-row").filter({ hasText: "Gemini 3.1 Pro" });
    await antigravityRow.waitFor();
    await antigravityRow.getByRole("button", { name: "Connect Google Antigravity OAuth", exact: true }).click();

    const dialog = page.getByRole("dialog").filter({ hasText: "Google Antigravity OAuth" });
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel("OAuth client secret", { exact: true }).count(), 1);
    assert.equal(await dialog.getByRole("button", { name: "Save credential", exact: true }).isDisabled(), true);
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("interface scale defaults to 100 percent and persists per renderer profile", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 }, locale: "en-US" });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const scale = page.getByLabel("Interface scale");
    await scale.waitFor();
    assert.equal(await scale.inputValue(), "100");
    assert.equal(await page.evaluate(() => document.documentElement.style.zoom), "1");

    await scale.selectOption("120");
    assert.equal(await page.evaluate(() => document.documentElement.style.zoom), "1.2");
    assert.equal(await page.evaluate(() => localStorage.getItem("codex-router-ui-scale")), "120");

    await page.reload({ waitUntil: "domcontentloaded" });
    const persistedScale = page.getByLabel("Interface scale");
    await persistedScale.waitFor();
    assert.equal(await persistedScale.inputValue(), "120");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.uiScale), "120");
    assert.equal(await page.evaluate(() => document.documentElement.style.zoom), "1.2");
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("Settings exposes explicit native ChatGPT account switching without Router lifecycle changes", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: "en-US" });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const accountsSection = page.locator("section.panel-section").filter({
      has: page.getByRole("heading", { name: "ChatGPT 原生账号", exact: true }),
    });
    await accountsSection.waitFor();
    const text = await accountsSection.innerText();
    assert.match(text, /主账号/);
    assert.match(text, /备用账号/);
    assert.match(text, /Router 始终保持运行/);
    assert.match(text, /不会停止或重启 Router 4202\/4203/);
    assert.match(text, /不自动轮换账号/);

    await accountsSection.getByRole("button", { name: "+ 添加 ChatGPT 账号", exact: true }).click();
    const addDialog = page.getByRole("dialog").filter({ hasText: "添加 ChatGPT 账号" });
    await addDialog.waitFor();
    assert.match(await addDialog.innerText(), /localhost 回调/);
    assert.equal(await addDialog.getByRole("button", { name: "设备代码登录（备用）", exact: true }).isVisible(), true);
    await addDialog.getByRole("button", { name: "浏览器 OAuth / 无痕登录（推荐）", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "startCodexAccountBrowserLogin"));
    await accountsSection.getByText("等待浏览器 OAuth 回调", { exact: true }).waitFor();
    assert.match(
      await accountsSection.getByLabel("Codex OAuth 授权地址").inputValue(),
      /auth\.openai\.com\/oauth\/authorize/,
    );
    const callbackInput = accountsSection.getByLabel("Codex OAuth 回调 URL");
    await callbackInput.fill("http://localhost:1455/auth/callback?code=test-code&state=state-123");
    await accountsSection.getByRole("button", { name: "提交回调 URL", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "submitCodexAccountCallback"
        && call.args[0].includes("code=test-code")
        && call.args[0].includes("state=state-123")));
    await accountsSection.getByText("localhost 回调已转交给官方 Codex 登录进程", { exact: false }).waitFor();
    await accountsSection.getByRole("button", { name: "取消本次登录", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "cancelCodexAccountLogin"));

    const backupRow = accountsSection.locator(".codex-account-row").filter({ hasText: "备用账号" });
    await backupRow.getByRole("button", { name: "切换", exact: true }).click();
    const dialog = page.getByRole("dialog").filter({ hasText: "切换 ChatGPT 原生账号？" });
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Router 4202\/4203/);
    assert.match(await dialog.innerText(), /config\.toml/);
    await dialog.getByText("未完成的 Native GPT 任务", { exact: true }).waitFor();
    assert.match(await dialog.innerText(), /project-a/);
    assert.match(await dialog.innerText(), /gpt-5\.6-luna/);
    assert.match(await dialog.innerText(), /Auto Resume 只是附加能力/);
    assert.equal(await dialog.getByRole("button", { name: "仅切换账号", exact: true }).count(), 1);
    await dialog.getByRole("button", { name: "切换并接力此对话", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "switchCodexAccount"
        && call.args[0] === "22222222-2222-4222-8222-222222222222"
        && call.args[1]?.handoffThreadId === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
    await accountsSection.getByText("同一 Native GPT thread 接力", { exact: false }).waitFor();
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("Settings keeps ChatGPT Web behind Router and isolates Chat On Steroids", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: "en-US" });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const bridgeSection = page.locator("section.panel-section").filter({
      has: page.getByRole("heading", { name: "ChatGPT Web Bridge", exact: true }),
    });
    await bridgeSection.waitFor();
    assert.match(await bridgeSection.innerText(), /Audited v5\.0\.8/);
    assert.match(await bridgeSection.innerText(), /Codex Router \(loopback, capability path redacted\)/);
    assert.match(await bridgeSection.innerText(), /Managed sidecar 隔离/);
    assert.match(await bridgeSection.innerText(), /影子 Codex 配置/);
    assert.match(await bridgeSection.innerText(), /Chat On Steroids 保持隔离/);
    assert.equal(await bridgeSection.getByText("Ready to discover", { exact: true }).count(), 1);

    await bridgeSection.getByRole("button", { name: "Verify isolation", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "controlCodexChatGptWeb" && call.args[0] === "verify-isolation"));
    await bridgeSection.getByText("Isolation verified:", { exact: false }).waitFor();
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("Settings exposes Codex Auto Resume as an explicit sidecar with reset-credit consent", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, locale: "en-US" });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const autoResumeSection = page.locator("section.panel-section").filter({
      has: page.getByRole("heading", { name: "Codex Auto Resume", exact: true }),
    });
    await autoResumeSection.waitFor();
    assert.equal(await autoResumeSection.getByText("v0.2.2", { exact: false }).count() > 0, true);
    assert.equal(await autoResumeSection.getByText("主账号 · fingerprint aaaabbbbcccc", { exact: true }).count(), 1);
    assert.equal(await autoResumeSection.getByText("Guarded", { exact: true }).count(), 1);
    assert.equal(await autoResumeSection.getByText("Reset credit 自动使用已开启", { exact: true }).count(), 0);
    const resetCreditToggle = autoResumeSection.getByRole("checkbox", { name: "Auto redeem weekly reset credit" });
    assert.equal(await resetCreditToggle.isChecked(), false);

    await autoResumeSection.getByRole("button", { name: "绑定到当前账号", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "bindCodexAutoResumeThread" && call.args[0] === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));

    await autoResumeSection.getByRole("button", { name: "Run doctor", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "controlCodexAutoResume" && call.args[0] === "doctor"));
    await page.getByText("app_server OK ok", { exact: false }).waitFor();

    await autoResumeSection.getByRole("button", { name: "Dry-run scan", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "controlCodexAutoResume" && call.args[0] === "dry-run"));
    await page.getByText("dry-run waiting=0", { exact: false }).waitFor();

    await autoResumeSection.getByRole("button", { name: "Enable autostart", exact: true }).click();
    const dialog = page.getByRole("dialog").filter({ hasText: "Enable Codex Auto Resume?" });
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /weekly reset credit 自动使用为关闭状态/);
    await dialog.getByRole("button", { name: "Enable autostart", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "controlCodexAutoResume" && call.args[0] === "enable-autostart"));
    await autoResumeSection.getByText("Running", { exact: true }).waitFor();
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("Harness exposes Light v2 mode and temporary specialized skill controls", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 }, locale: "en-US" });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Harness", exact: true }).click();
    await page.getByRole("heading", { name: "Codex Skills", exact: true }).waitFor();
    assert.equal(await page.getByText("LIGHT v2", { exact: true }).count(), 1);
    for (const group of ["Core", "Specialized", "Invalid", "Plugin Cache"]) {
      assert.equal(await page.locator(".lhc-skill-group > header > div > strong").filter({ hasText: group }).count(), 1);
    }
    assert.match(await page.locator(".lhc-skill-summary").innerText(), /Estimated skill prompt/i);
    const invalid = page.locator('.lhc-skill-row[data-category="invalid"]').filter({ hasText: "test-runner" });
    await invalid.waitFor();
    assert.match(await invalid.innerText(), /Missing YAML frontmatter|Invalid/);
    const pluginCache = page.locator('.lhc-skill-row[data-category="plugin-cache"]').filter({ hasText: "visualize" });
    await pluginCache.waitFor();
    assert.match(await pluginCache.innerText(), /Active plugin/i);
    const xiaohongshu = page.locator(".lhc-skill-row").filter({ hasText: "xiaohongshu-box" });
    await xiaohongshu.waitFor();
    const toggle = xiaohongshu.getByLabel("xiaohongshu-box specialized skill");
    assert.equal(await toggle.isChecked(), false);
    await toggle.click();
    await xiaohongshu.getByText("Temporary", { exact: true }).waitFor();
    assert.equal(await toggle.isChecked(), true);
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "setCodexSkillException" && call.args[0] === "xiaohongshu-box" && call.args[1] === true));

    await page.getByRole("button", { name: "Light v2", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "setCodexContextMode" && call.args[0] === "light"));
    await page.waitForFunction(() => document.querySelector('.lhc-skill-row[data-temporary="true"]') === null);
    assert.equal(await toggle.isChecked(), false);
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("independent control-center reads reveal each ready page region", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 }, locale: "en-US" });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?snapshotDelayMs=3000&accountDelayMs=4000`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    // Only the responsiveness checks use the tight budget. A cold browser
    // navigation includes process and module startup and needs a normal timeout.
    page.setDefaultTimeout(1_500);
    await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
    await page.locator(".service-health-strip").waitFor();
    await page.locator('.db-breakdown-list[aria-label="Providers usage breakdown"]')
      .getByText("DeepSeek", { exact: true })
      .waitFor();
    assert.equal(await page.locator(".db-breakdown-panel .panel-skeleton").count(), 0);

    await page.getByRole("button", { name: "Models", exact: true }).click();
    await page.getByRole("heading", { name: "Models", exact: true }).waitFor();
    const connections = page.locator(".pm-connections:not(.pm-connections-loading)");
    await connections.waitFor();
    assert.match(await connections.innerText(), /DeepSeek/);
    await page.locator(".pm-models-loading").waitFor();

    page.setDefaultTimeout(7_000);
    await page.locator(".pm-family-row").filter({ hasText: "DeepSeek Chat" }).waitFor();
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("a transient Codex account-usage timeout retries once without pinning an error", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 }, locale: "en-US" });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?rejectAccountUsageOnce=1`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(() => window.routerControlTest.usageReads().account >= 2);
    await page.waitForFunction(() => window.routerControlTest.navigationReady());
    assert.equal(
      await page.evaluate(() => window.routerControlTest.navigate({ destination: "usage", sourceId: "openai" })),
      true,
    );
    await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
    assert.equal(await page.getByLabel("Usage source").inputValue(), "chatgpt-subscription");
    assert.equal(await page.getByText("Some router data could not load", { exact: true }).count(), 0);
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("usage polling surfaces rejections and ignores older overlapping results", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 }, locale: "en-US" });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?providerUsageDelayMs=400&staleProviderUsage=1&rejectAccountUsageAfter=2&pollOnceMs=50`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(() => {
      const reads = window.routerControlTest.usageReads();
      return reads.account >= 2 && reads.provider >= 2;
    });
    await page.getByText("Account usage poll failed", { exact: true }).waitFor();
    await page.waitForTimeout(450);
    assert.equal(
      await page
        .locator('.db-breakdown-list[aria-label="Providers usage breakdown"] .db-breakdown-row')
        .filter({ hasText: "DeepSeek" })
        .locator(".db-breakdown-value")
        .innerText(),
      "24k",
    );
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});
