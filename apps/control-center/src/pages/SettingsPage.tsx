import { useEffect, useMemo, useState } from "react";
import { AppWindow, Eye, Moon, RefreshCw, Server, Sun, Wrench } from "lucide-react";
import { Badge, Button, Dialog, InlineNotice, PageHeader, SectionHeading, Toggle } from "../components";
import { compactNumber } from "../lib";
import { LANGUAGE_OPTIONS, type LanguageId, type Translate } from "../i18n";
import { UI_SCALE_OPTIONS, type UiScale } from "../ui-scale";
import type { ChatGptSessionStatus, CodexAccountProfile, CodexAccountProfilesSnapshot, CodexAgentMode, CodexAgentModeSnapshot, CodexAutoResumeAction, CodexAutoResumeSnapshot, CodexChatGptWebAction, CodexChatGptWebSnapshot, DoctorSnapshot, HarnessSession, PresenceSnapshot, RouterControlApi, RouterHealth, RouterTarget, VisionEngine } from "../types";
import { useOptimisticValues, type RunAction } from "../useOptimisticValues";

// Mirrors RETENTION_MIN/MAX/DEFAULT_TTL_DAYS in src/tool-result-retention.mjs.
// `0` is not "no retention" -- it is the stored answer meaning "keep the
// archived originals until I say otherwise", so it gets its own option rather
// than being folded in with the default.
const RETENTION_DEFAULT_TTL_DAYS = 7;
const RETENTION_CHOICES = [1, 3, 7, 14, 30, 90];

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

export function SettingsPage({ target, health, presence, chatgptSession, api, theme, onTheme, language, onLanguage, uiScale, onUiScale, t, refreshing, onRefresh, runAction }: {
  target?: RouterTarget;
  health?: RouterHealth;
  presence?: PresenceSnapshot;
  chatgptSession?: ChatGptSessionStatus;
  api?: RouterControlApi;
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  language: LanguageId;
  onLanguage: (language: LanguageId) => void;
  uiScale: UiScale;
  onUiScale: (scale: UiScale) => void;
  t: Translate;
  refreshing: boolean;
  onRefresh: () => void;
  runAction: RunAction;
}) {
  const [confirmTrayDisable, setConfirmTrayDisable] = useState(false);
  const [confirmSessionSharing, setConfirmSessionSharing] = useState(false);
  const [confirmRepair, setConfirmRepair] = useState(false);
  const [confirmAutoResumeEnable, setConfirmAutoResumeEnable] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairReport, setRepairReport] = useState<DoctorSnapshot | null>(null);
  const [trayCapability, setTrayCapability] = useState<{ supported?: boolean; why?: string }>();
  const [codexAgentMode, setCodexAgentMode] = useState<CodexAgentModeSnapshot>();
  const [codexAutoResume, setCodexAutoResume] = useState<CodexAutoResumeSnapshot>();
  const [codexAutoResumeReport, setCodexAutoResumeReport] = useState<string>();
  const [codexChatGptWeb, setCodexChatGptWeb] = useState<CodexChatGptWebSnapshot>();
  const [codexChatGptWebReport, setCodexChatGptWebReport] = useState<string>();
  const [codexAccounts, setCodexAccounts] = useState<CodexAccountProfilesSnapshot>();
  const [codexAccountsReport, setCodexAccountsReport] = useState<string>();
  const [accountCallbackUrl, setAccountCallbackUrl] = useState("");
  const [accountEditor, setAccountEditor] = useState<{ mode: "add" | "rename"; id?: string; value: string } | null>(null);
  const [pendingAccountSwitch, setPendingAccountSwitch] = useState<CodexAccountProfile | null>(null);
  const [handoffCandidate, setHandoffCandidate] = useState<HarnessSession | null>(null);
  const [handoffLoading, setHandoffLoading] = useState(false);
  const [pendingAccountDelete, setPendingAccountDelete] = useState<CodexAccountProfile | null>(null);
  useEffect(() => {
    let active = true;
    if (!api) {
      setTrayCapability(undefined);
      return () => { active = false; };
    }
    void api.controlTray("status").then((result) => {
      if (!active) return;
      const status = (result as { status?: { supported?: boolean; why?: string } } | undefined)?.status;
      setTrayCapability(status);
    }).catch(() => {
      if (active) setTrayCapability(undefined);
    });
    return () => { active = false; };
  }, [api, refreshing]);
  useEffect(() => {
    let active = true;
    if (!api || typeof api.getCodexAgentMode !== "function") {
      setCodexAgentMode(api ? { supported: false, mode: "unknown", why: "当前 Control Center 后端尚未提供 Agent Mode 接口。" } : undefined);
      return () => { active = false; };
    }
    void api.getCodexAgentMode().then((result) => {
      if (active) setCodexAgentMode(result);
    }).catch((error) => {
      if (!active) return;
      setCodexAgentMode({
        supported: false,
        mode: "unknown",
        why: error instanceof Error ? error.message : "Codex Agent Mode is unavailable.",
      });
    });
    return () => { active = false; };
  }, [api, refreshing]);
  useEffect(() => {
    let active = true;
    if (!api || typeof api.getCodexAutoResume !== "function") {
      setCodexAutoResume(undefined);
      return () => { active = false; };
    }
    void api.getCodexAutoResume().then((result) => {
      if (active) setCodexAutoResume(result);
    }).catch(() => {
      if (active) setCodexAutoResume(undefined);
    });
    return () => { active = false; };
  }, [api, refreshing]);
  useEffect(() => {
    let active = true;
    if (!api || typeof api.getCodexChatGptWeb !== "function") {
      setCodexChatGptWeb(undefined);
      return () => { active = false; };
    }
    void api.getCodexChatGptWeb().then((result) => {
      if (active) setCodexChatGptWeb(result);
    }).catch((error) => {
      if (!active) return;
      setCodexChatGptWeb({
        supported: false,
        installed: false,
        repository: "https://github.com/miuuyy/codex-chatgpt-web",
        auditedVersion: "5.0.8",
        providerId: "chatgpt-web",
        home: "",
        shadowCodexHome: "",
        launcherDataDir: "",
        running: false,
        daemonRunning: false,
        bridgeReachable: false,
        daemonEndpoint: "http://127.0.0.1:17841/v1",
        browserReady: false,
        onboardingComplete: false,
        browserSmokePassed: false,
        configured: false,
        daemonOwner: "none",
        routeOwner: "unknown",
        routeDisplay: "Unable to read Codex route",
        directRouteConflict: false,
        safeToDiscover: false,
        upstreamExternalProviderSupported: false,
        why: error instanceof Error ? error.message : "ChatGPT Web bridge status is unavailable.",
      });
    });
    return () => { active = false; };
  }, [api, refreshing]);
  useEffect(() => {
    let active = true;
    if (!api || typeof api.getCodexAccounts !== "function") {
      setCodexAccounts(undefined);
      return () => { active = false; };
    }
    void api.getCodexAccounts().then((result) => {
      if (active) setCodexAccounts(result);
    }).catch((error) => {
      if (!active) return;
      setCodexAccounts({
        supported: false,
        root: "",
        profiles: [],
        liveAuthPresent: false,
        liveManaged: false,
        desktopRunning: false,
        routerRestartRequired: false,
        configMutationRequired: false,
        why: error instanceof Error ? error.message : "Codex account profiles are unavailable.",
      });
    });
    return () => { active = false; };
  }, [api, refreshing]);
  useEffect(() => {
    const session = codexAccounts?.loginSession;
    if (!api || typeof api.getCodexAccounts !== "function" || !session || !["starting", "waiting"].includes(session.status)) {
      return undefined;
    }
    let active = true;
    const poll = () => {
      void api.getCodexAccounts().then((result) => {
        if (!active) return;
        setCodexAccounts(result);
        if (result.loginSession?.report) setCodexAccountsReport(result.loginSession.report);
      }).catch(() => {
        // Keep the current OAuth instructions visible through transient read failures.
      });
    };
    const timer = window.setInterval(poll, 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [api, codexAccounts?.loginSession?.id, codexAccounts?.loginSession?.status]);
  useEffect(() => {
    setAccountCallbackUrl("");
  }, [codexAccounts?.loginSession?.id]);
  useEffect(() => {
    let active = true;
    if (!pendingAccountSwitch || !api || typeof api.getContextSessions !== "function") {
      setHandoffCandidate(null);
      setHandoffLoading(false);
      return () => { active = false; };
    }
    setHandoffLoading(true);
    void api.getContextSessions().then((snapshot) => {
      if (!active) return;
      const candidates = snapshot.sessions
        .filter((session) => (
          session.harnessId === "codex"
          && session.resumable
          && !session.archived
          // Cross-provider family continuation has different compact/storage
          // semantics. Account handoff is intentionally Native GPT → Native GPT.
          && (!session.model || !session.model.includes("/"))
        ))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      setHandoffCandidate(candidates[0] || null);
      setHandoffLoading(false);
    }).catch(() => {
      if (!active) return;
      setHandoffCandidate(null);
      setHandoffLoading(false);
    });
    return () => { active = false; };
  }, [api, pendingAccountSwitch]);
  const trayControlsUnavailable = trayCapability?.supported === false;
  const repairFailures = useMemo(
    () => (repairReport?.checks ?? []).filter((check) => check.status === "fail"),
    [repairReport],
  );
  const sessionSharingEnabled = chatgptSession?.sharing === "enabled";
  const sessionLoginLabel = chatgptSession?.session === "usable"
    ? (typeof chatgptSession.expiresInHours === "number"
      ? t("settings.chatgptSession.status.loginUsableHours", { hours: chatgptSession.expiresInHours })
      : t("settings.chatgptSession.status.loginUsable"))
    : chatgptSession?.session === "expired"
      ? t("settings.chatgptSession.status.loginExpired")
      : chatgptSession?.present
        ? t("settings.chatgptSession.status.loginUnavailableDetected")
        : t("settings.chatgptSession.status.loginUnavailableLogin");
  const sessionSharingLabel = chatgptSession
    ? `${t(sessionSharingEnabled
      ? "settings.chatgptSession.status.sharingEnabled"
      : "settings.chatgptSession.status.sharingDisabled")} · ${sessionLoginLabel}`
    : t("settings.chatgptSession.status.unavailable");
  const codexAgentModeDetail = codexAgentMode?.mode === "single"
    ? "当前所选主模型 · Native Multi-Agent OFF · 新建 Codex 会话后生效。"
    : codexAgentMode?.mode === "team"
      ? "Native Multi-Agent ON · 不锁定主模型；精确 Sol + Luna 编排需先选择 Sol，再显式输入 $sol-luna-orchestrator。"
      : codexAgentMode?.why || "正在读取项目级 Agent 模式…";
  const changeCodexAgentMode = (mode: CodexAgentMode) => {
    if (!api || typeof api.setCodexAgentMode !== "function" || codexAgentMode?.supported === false) return;
    void runAction("Change Codex Agent Mode", async () => {
      const result = await api.setCodexAgentMode(mode);
      setCodexAgentMode(result);
      return result;
    });
  };
  const runCodexAutoResume = (action: CodexAutoResumeAction, label: string) => {
    if (!api || typeof api.controlCodexAutoResume !== "function") return;
    void runAction(label, async () => {
      const result = await api.controlCodexAutoResume(action);
      setCodexAutoResume(result);
      if (result.report) setCodexAutoResumeReport(result.report);
      return result;
    });
  };
  const bindAutoResumeThread = (threadId: string) => {
    if (!api || typeof api.bindCodexAutoResumeThread !== "function") return;
    void runAction("Bind Auto Resume thread", async () => {
      const result = await api.bindCodexAutoResumeThread(threadId);
      setCodexAutoResume(result);
      if (result.report) setCodexAutoResumeReport(result.report);
      return result;
    });
  };
  const runCodexChatGptWeb = (action: CodexChatGptWebAction, label: string) => {
    if (!api || typeof api.controlCodexChatGptWeb !== "function") return;
    void runAction(label, async () => {
      const result = await api.controlCodexChatGptWeb(action);
      setCodexChatGptWeb(result);
      if (result.report) setCodexChatGptWebReport(result.report);
      return result;
    });
  };
  const runCodexAccountAction = (label: string, action: () => Promise<CodexAccountProfilesSnapshot>) => {
    void runAction(label, async () => {
      const result = await action();
      setCodexAccounts(result);
      if (result.report) setCodexAccountsReport(result.report);
      if (api && typeof api.getCodexAutoResume === "function") {
        const autoResume = await api.getCodexAutoResume();
        setCodexAutoResume(autoResume);
      }
      return result;
    });
  };
  const formatAccountStatus = (profile: CodexAccountProfile) => {
    if (profile.active) return profile.refreshRequired ? "当前使用 · 待刷新" : "当前使用";
    if (profile.refreshRequired) return "可切换 · 打开 Codex 后刷新";
    if (profile.expired) return "登录已过期";
    if (!profile.usable) return "登录不可用";
    if (typeof profile.expiresInHours === "number") return `登录有效 · 约 ${profile.expiresInHours}h`;
    return "登录有效";
  };

  // Repair reinstalls and restarts the service, so it can outlast several
  // ordinary actions. `runAction` owns the toast and the refresh; the report
  // is kept here as well because runAction discards the resolved value and a
  // repair that finishes with checks still failing needs to say which ones.
  const runRepair = async () => {
    if (!api || repairing) return;
    setRepairing(true);
    setRepairReport(null);
    try {
      await runAction(t("settings.maintenance.fix"), async () => {
        const report = await api.repairInstall();
        setRepairReport(report);
        if (!report.ok) {
          const failed = report.checks?.find((check) => check.status === "fail");
          throw new Error(failed ? `${failed.name}: ${failed.detail || "check failed"}` : "Repair finished with failing checks.");
        }
        return report;
      });
    } finally {
      setRepairing(false);
    }
  };

  const economy = target?.modelSettings?.contextEconomy;
  const aging = target?.modelSettings?.toolResultAging;
  const agingLocked = aging?.environmentOverride === true;
  const stats = aging?.stats;
  const hasSavings = typeof stats?.estimatedTokensSaved === "number" && stats.estimatedTokensSaved > 0;
  // `retentionTtlDays` is absent only when nobody has answered, which is a
  // different state from a stored 0. Keep them apart in the select.
  const ttlValue = aging?.retentionTtlDays === undefined ? "default" : String(aging.retentionTtlDays);
  const ttlChoices = aging?.retentionTtlDays !== undefined && aging.retentionTtlDays > 0
      && !RETENTION_CHOICES.includes(aging.retentionTtlDays)
    ? [...RETENTION_CHOICES, aging.retentionTtlDays].sort((left, right) => left - right)
    : RETENTION_CHOICES;

  const bridge = target?.modelSettings?.visionBridge;
  const toggleStates = useMemo(() => new Map([
    ["signed-routing", target?.signedRouting === true],
    ["context-economy", economy?.enabled === true],
    ["tool-result-aging", aging?.enabled === true],
    ["native-tool-result-aging", aging?.nativeEnabled === true],
    ["vision-bridge", bridge?.enabled === true],
  ]), [aging?.enabled, aging?.nativeEnabled, bridge?.enabled, economy?.enabled, target?.signedRouting]);
  const optimisticToggles = useOptimisticValues(toggleStates, runAction);
  const toolResultAgingEnabled = optimisticToggles.value("tool-result-aging", aging?.enabled === true);
  // Same split the tray menu shows: the models the operator already pays for,
  // then the ones their ChatGPT plan covers. Which bill a choice lands on is
  // the only thing separating two otherwise identical engine names.
  const paidEngines = bridge?.paidEngines ?? [];
  const nativeEngines = bridge?.nativeEngines ?? [];
  const selectedEngine = bridge?.engine || "auto";
  const selectedEngineMeta = [...paidEngines, ...nativeEngines].find((engine) => engine.slug === selectedEngine);
  // A pinned engine can leave both lists -- a native model that dropped out of
  // the picker, a provider switched off. The tray keeps naming it; carry it as
  // its own entry so the select cannot silently fall back to its first option
  // and report an engine the router is not using.
  const unlistedEngine: VisionEngine | null = selectedEngine !== "auto" && selectedEngine !== "local" && !selectedEngineMeta
    ? { slug: selectedEngine, displayName: bridge?.resolvedEngineName || bridge?.resolvedEngine || selectedEngine }
    : null;
  const engineEfforts = selectedEngineMeta?.efforts?.length
    ? selectedEngineMeta.efforts
    : bridge?.availableEfforts ?? [];
  const selectedEffort = bridge?.effort || "default";
  // Same reason as the engine above: show the pinned level even when the
  // engine that declared it is no longer listed.
  const effortOptions = selectedEffort !== "default" && !engineEfforts.includes(selectedEffort)
    ? [...engineEfforts, selectedEffort]
    : engineEfforts;

  return (
    <>
      <PageHeader eyebrow={t("settings.eyebrow")} title={t("settings.title")} description={t("settings.description")} onRefresh={onRefresh} refreshing={refreshing} />
      <div className="settings-columns">
        <div className="page-stack">
          <section className="panel-section">
            <SectionHeading title={t("settings.routing.title")} description={t("settings.routing.description")} />
            <div className="settings-list">
              <div className="setting-row">
                <div><strong>{t("settings.signedRouting.title")}</strong><small>{t("settings.signedRouting.detail")}</small></div>
                <Toggle checked={optimisticToggles.value("signed-routing", target?.signedRouting === true)} disabled={!api || !target} label={t("settings.signedRouting.title")} onChange={(enabled) => api && void optimisticToggles.mutate("signed-routing", enabled, "Change signed routing", () => api.setSignedRouting(enabled))} />
              </div>
              <div className="setting-row">
                <div>
                  <strong>{t("settings.chatgptSession.title")}</strong>
                  <small>{t("settings.chatgptSession.detail")} {sessionSharingLabel}</small>
                </div>
                <Toggle
                  checked={sessionSharingEnabled}
                  disabled={!api || !chatgptSession || (!sessionSharingEnabled && chatgptSession.session !== "usable")}
                  label={t("settings.chatgptSession.title")}
                  onChange={(enabled) => {
                    if (!api) return;
                    if (enabled) setConfirmSessionSharing(true);
                    else void runAction(t("settings.chatgptSession.action.disable"), () => api.setChatGptSessionSharing(false));
                  }}
                />
              </div>
            </div>
            <InlineNotice tone="neutral" title={t("settings.restart.title")}>{t("settings.restart.body")}</InlineNotice>
          </section>

          <section className="panel-section">
            <SectionHeading
              title="ChatGPT 原生账号"
              description="管理 Codex Native GPT 登录身份。默认使用官方浏览器 OAuth；无痕窗口若无法自动回调 localhost，可把完整回调 URL 手工提交给 Control Center。设备代码登录保留为备用。"
            />
            <div className="settings-list codex-account-list">
              {codexAccounts?.profiles.length ? codexAccounts.profiles.map((profile) => (
                <div className="setting-row codex-account-row" key={profile.id}>
                  <div className="codex-account-copy">
                    <div className="codex-account-title">
                      <strong>{profile.label}</strong>
                      <Badge tone={profile.active ? "success" : profile.expired || !profile.usable ? "warning" : "neutral"}>
                        {formatAccountStatus(profile)}
                      </Badge>
                    </div>
                    <small>
                      {profile.identityFingerprint ? `identity ${profile.identityFingerprint}` : "identity 已隔离"}
                      {profile.markedActive && !profile.liveMatches ? " · 活动标记与当前 auth.json 不一致" : ""}
                    </small>
                  </div>
                  <div className="codex-account-actions">
                    {!profile.active ? (
                      <Button
                        variant="primary"
                        disabled={!api || !profile.usable}
                        onClick={() => setPendingAccountSwitch(profile)}
                      >
                        切换
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      disabled={!api}
                      onClick={() => setAccountEditor({ mode: "rename", id: profile.id, value: profile.label })}
                    >
                      重命名
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={!api || profile.active}
                      onClick={() => setPendingAccountDelete(profile)}
                    >
                      删除
                    </Button>
                  </div>
                </div>
              )) : (
                <div className="setting-row static-row">
                  <div>
                    <strong>{codexAccounts?.liveAuthPresent ? "当前 Codex 登录尚未纳入账号管理" : "尚未保存 ChatGPT 账号"}</strong>
                    <small>
                      {codexAccounts?.liveAuthPresent
                        ? "首次添加第二个账号时，Control Center 会先把当前 auth.json 保存为“当前 Codex 账号”，再启动隔离登录。"
                        : "点击下方按钮，通过官方 Codex 登录流程添加账号。Control Center 不接收密码或 token。"}
                    </small>
                  </div>
                  <Badge tone={codexAccounts?.liveAuthPresent ? "neutral" : "warning"}>
                    {codexAccounts?.liveAuthPresent ? "Live login detected" : "No account"}
                  </Badge>
                </div>
              )}
            </div>
            <InlineNotice tone="neutral" title="Router 始终保持运行">
              账号切换不会停止或重启 Router 4202/4203，也不会修改 config.toml、model_provider、模型 catalog、第三方 Provider 或 ChatGPT Web Bridge。第一版只做手动显式切换，不自动轮换账号。
            </InlineNotice>
            {codexAccounts?.desktopRunning ? (
              <InlineNotice tone="warning" title="切换前需退出 Codex Desktop">
                当前检测到 Codex Desktop 正在运行。添加和重命名不受影响；真正切换账号时请先完全退出 Codex Desktop。Router 无需退出。
              </InlineNotice>
            ) : null}
            {codexAccounts?.loginSession ? (
              <InlineNotice
                tone={codexAccounts.loginSession.status === "completed"
                  ? "success"
                  : codexAccounts.loginSession.status === "failed"
                    ? "danger"
                    : "neutral"}
                title={codexAccounts.loginSession.status === "completed"
                  ? "ChatGPT 登录完成"
                  : codexAccounts.loginSession.status === "failed"
                    ? "ChatGPT 登录未完成"
                    : codexAccounts.loginSession.mode === "browser"
                      ? "等待浏览器 OAuth 回调"
                      : "等待设备代码授权"}
              >
                <div className="credential-form">
                  <p>
                    {codexAccounts.loginSession.status === "completed"
                      ? codexAccounts.loginSession.report || "新账号已保存。"
                      : codexAccounts.loginSession.status === "failed"
                        ? codexAccounts.loginSession.error || "登录未完成。"
                        : codexAccounts.loginSession.mode === "browser"
                          ? codexAccounts.loginSession.callbackSubmittedAt
                            ? "localhost 回调已提交给官方 Codex 登录进程，正在等待 auth.json 写入。"
                            : "可在弹出的浏览器里直接登录，也可以复制同一授权地址到 Chrome 无痕窗口。若登录后最终停在 localhost:1455 页面或显示无法访问，请复制地址栏中的完整回调 URL 粘贴到下方。"
                          : codexAccounts.loginSession.status === "starting"
                            ? "官方 Codex 正在申请一次性设备代码。"
                            : "在 Chrome 无痕窗口中打开下面的验证地址，登录目标 ChatGPT 账号后输入一次性代码。此备用流程完全不依赖 localhost 回调。"}
                  </p>

                  {codexAccounts.loginSession.mode === "browser" && codexAccounts.loginSession.authorizationUrl ? (
                    <>
                      <input
                        aria-label="Codex OAuth 授权地址"
                        readOnly
                        value={codexAccounts.loginSession.authorizationUrl}
                        onFocus={(event) => event.currentTarget.select()}
                      />
                      <Button
                        variant="secondary"
                        disabled={!api}
                        onClick={() => api && void api.openExternal(codexAccounts.loginSession!.authorizationUrl!)}
                      >
                        打开本次授权页
                      </Button>
                    </>
                  ) : null}

                  {codexAccounts.loginSession.mode === "browser"
                    && ["starting", "waiting"].includes(codexAccounts.loginSession.status) ? (
                    <>
                      <input
                        aria-label="Codex OAuth 回调 URL"
                        placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                        value={accountCallbackUrl}
                        onChange={(event) => setAccountCallbackUrl(event.target.value)}
                        onFocus={(event) => event.currentTarget.select()}
                      />
                      <div className="dialog-actions">
                        <Button
                          variant="primary"
                          disabled={!api || !accountCallbackUrl.trim()}
                          onClick={() => api && runCodexAccountAction(
                            "Submit ChatGPT OAuth callback",
                            () => api.submitCodexAccountCallback(accountCallbackUrl.trim()),
                          )}
                        >
                          提交回调 URL
                        </Button>
                      </div>
                    </>
                  ) : null}

                  {codexAccounts.loginSession.mode === "device" && codexAccounts.loginSession.verificationUrl ? (
                    <input
                      aria-label="设备登录地址"
                      readOnly
                      value={codexAccounts.loginSession.verificationUrl}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  ) : null}
                  {codexAccounts.loginSession.mode === "device" && codexAccounts.loginSession.userCode ? (
                    <input
                      aria-label="设备登录一次性代码"
                      readOnly
                      value={codexAccounts.loginSession.userCode}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  ) : null}

                  <div className="dialog-actions">
                    {codexAccounts.loginSession.mode === "device" && codexAccounts.loginSession.verificationUrl ? (
                      <Button
                        variant="secondary"
                        disabled={!api}
                        onClick={() => api && void api.openExternal(codexAccounts.loginSession!.verificationUrl!)}
                      >
                        打开设备登录页
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      disabled={!api}
                      onClick={() => api && runCodexAccountAction(
                        ["starting", "waiting"].includes(codexAccounts.loginSession!.status)
                          ? "Cancel ChatGPT login"
                          : "Clear ChatGPT login status",
                        () => api.cancelCodexAccountLogin(),
                      )}
                    >
                      {["starting", "waiting"].includes(codexAccounts.loginSession.status) ? "取消本次登录" : "关闭状态"}
                    </Button>
                  </div>
                </div>
              </InlineNotice>
            ) : null}
            {codexAccounts?.why ? (
              <InlineNotice tone="warning" title="账号状态需要确认">{codexAccounts.why}</InlineNotice>
            ) : null}
            {codexAccountsReport ? (
              <InlineNotice tone="success" title="最近一次账号操作">{codexAccountsReport}</InlineNotice>
            ) : null}
            <div className="settings-actions">
              <Button
                variant="primary"
                disabled={!api || codexAccounts?.supported === false}
                onClick={() => setAccountEditor({
                  mode: "add",
                  value: `账号 ${(codexAccounts?.profiles.length || 0) + 1}`,
                })}
              >
                + 添加 ChatGPT 账号
              </Button>
            </div>
          </section>

          <section className="panel-section">
            <SectionHeading title="Codex Agent 模式" description="项目级 Single / Multi-Agent 能力开关，不锁定 Codex 主模型；Sol + Luna 仍需显式调用编排 skill。" />
            <div className="settings-list">
              <div className="setting-row">
                <div>
                  <strong>执行模式</strong>
                  <small>{codexAgentModeDetail}</small>
                </div>
                <select
                  aria-label="Codex Agent 模式"
                  value={codexAgentMode?.mode || "unknown"}
                  disabled={!api || codexAgentMode?.supported !== true}
                  onChange={(event) => changeCodexAgentMode(event.target.value as CodexAgentMode)}
                >
                  {codexAgentMode?.mode === "unknown" ? <option value="unknown">状态未知</option> : null}
                  <option value="single">Single（默认）— 当前所选模型单代理</option>
                  <option value="team">Team 能力 — 显式 Sol + Luna 编排</option>
                </select>
              </div>
            </div>
            {codexAgentMode?.supported === false || codexAgentMode?.mode === "unknown" ? (
              <InlineNotice tone={codexAgentMode?.supported === false ? "warning" : "neutral"} title="Agent 模式状态">
                {codexAgentModeDetail}
              </InlineNotice>
            ) : null}
          </section>

          <section className="panel-section">
            <SectionHeading
              title="ChatGPT Web Bridge"
              description="唯一进入 Codex Router 主链路的 ChatGPT Web 候选；Control Center 只管理独立 launcher/bridge，Codex 的 route owner 必须继续是 Router。"
            />
            <div className="settings-list">
              <div className="setting-row static-row">
                <div>
                  <strong>Launcher</strong>
                  <small>{codexChatGptWeb?.installed
                    ? `Audited v${codexChatGptWeb.auditedVersion} · ${codexChatGptWeb.launcherPath || "installed"}`
                    : `Audited v${codexChatGptWeb?.auditedVersion || "5.0.8"} · 尚未安装`}</small>
                </div>
                <Badge tone={codexChatGptWeb?.running ? "success" : codexChatGptWeb?.installed ? "neutral" : "warning"}>
                  {codexChatGptWeb?.running ? "Running" : codexChatGptWeb?.installed ? "Installed" : "Not installed"}
                </Badge>
              </div>
              <div className="setting-row static-row">
                <div>
                  <strong>Browser host</strong>
                  <small>独立 managed profile · 登录、Temporary Chat 与 browser smoke 都只保存在 sidecar 目录。</small>
                </div>
                <Badge tone={codexChatGptWeb?.browserSmokePassed ? "success" : codexChatGptWeb?.browserReady ? "warning" : "neutral"}>
                  {codexChatGptWeb?.browserSmokePassed ? "Smoke passed" : codexChatGptWeb?.browserReady ? "Sign in required" : "Stopped"}
                </Badge>
              </div>
              <div className="setting-row static-row">
                <div>
                  <strong>Bridge daemon</strong>
                  <small>{codexChatGptWeb?.daemonEndpoint || "http://127.0.0.1:17841/v1"} · 仅 loopback · owner {codexChatGptWeb?.daemonOwner || "none"}</small>
                </div>
                <Badge tone={codexChatGptWeb?.bridgeReachable ? "success" : "neutral"}>
                  {codexChatGptWeb?.bridgeReachable ? "Reachable" : codexChatGptWeb?.daemonRunning ? "Starting" : "Stopped"}
                </Badge>
              </div>
              <div className="setting-row static-row">
                <div>
                  <strong>Codex route owner</strong>
                  <small>{codexChatGptWeb?.routeDisplay || "正在检查 Codex 路由…"}</small>
                </div>
                <Badge tone={codexChatGptWeb?.routeOwner === "router" ? "success" : codexChatGptWeb?.directRouteConflict ? "danger" : "warning"}>
                  {codexChatGptWeb?.routeOwner === "router" ? "Router" : codexChatGptWeb?.directRouteConflict ? "Conflict" : "Not Router"}
                </Badge>
              </div>
              <div className="setting-row static-row">
                <div>
                  <strong>Router provider</strong>
                  <small>chatgpt-web 已登记为 OpenAI Responses loopback provider；当前不会自动加入你现有的显式 provider 选择。</small>
                </div>
                <Badge tone={codexChatGptWeb?.safeToDiscover ? "success" : "neutral"}>
                  {codexChatGptWeb?.safeToDiscover ? "Ready to discover" : "Held"}
                </Badge>
              </div>
            </div>
            {codexChatGptWeb?.directRouteConflict ? (
              <InlineNotice tone="warning" title="检测到直接路由冲突">
                Codex 当前直接指向 ChatGPT Web 的 17841，而不是 Codex Router。Control Center 不会继续发布模型，也不会自动改写你的 Codex 配置。
              </InlineNotice>
            ) : (
              <InlineNotice tone="neutral" title="Managed sidecar 隔离">
                Managed Start 会给上游 launcher 注入独立的 CODEX_HOME 和 launcher data 目录。即使上游执行 Install models / route connect，也只会改写影子 Codex 配置；真实 Codex 仍由 4202 Router 接管。请不要从开始菜单直接启动 Codex Web GPT。
              </InlineNotice>
            )}
            {codexChatGptWeb?.browserReady && !codexChatGptWeb.browserSmokePassed ? (
              <InlineNotice tone="warning" title="需要一次 ChatGPT 登录">
                隔离 launcher 已经打开。请只在这个 Codex Web GPT 窗口中完成 ChatGPT 登录并运行 Browser smoke test；完成后再点击 Start 17841。这个登录不会改变真实 Codex 的 4202 路由。
              </InlineNotice>
            ) : null}
            <InlineNotice tone="neutral" title="Chat On Steroids 保持隔离">
              已安装的 CoS 继续作为独立实验工具使用，只研究 Goal / Loop / durable worker；它不接 Router、不接 Control Center，也不管理这里的 session、compact 或 subagent。
            </InlineNotice>
            {codexChatGptWeb?.why ? (
              <InlineNotice tone="neutral" title="ChatGPT Web 状态">{codexChatGptWeb.why}</InlineNotice>
            ) : null}
            {codexChatGptWebReport ? (
              <InlineNotice tone="neutral" title="最近一次 ChatGPT Web 操作">{codexChatGptWebReport}</InlineNotice>
            ) : null}
            <div className="settings-actions">
              {!codexChatGptWeb?.installed ? (
                <Button
                  variant="primary"
                  disabled={!api || codexChatGptWeb?.supported === false}
                  onClick={() => runCodexChatGptWeb("install", "Install audited ChatGPT Web bridge")}
                >
                  Install audited v{codexChatGptWeb?.auditedVersion || "5.0.8"}
                </Button>
              ) : !codexChatGptWeb.running ? (
                <Button
                  variant="primary"
                  disabled={!api || codexChatGptWeb.routeOwner !== "router"}
                  onClick={() => runCodexChatGptWeb("start-managed", "Start isolated ChatGPT Web browser")}
                >
                  Managed Start
                </Button>
              ) : !codexChatGptWeb.daemonRunning ? (
                <Button
                  variant="primary"
                  disabled={!api || !codexChatGptWeb.browserSmokePassed || codexChatGptWeb.routeOwner !== "router"}
                  onClick={() => runCodexChatGptWeb("start-daemon", "Start Router-managed ChatGPT Web daemon")}
                >
                  Start 17841
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  disabled={!api}
                  onClick={() => runCodexChatGptWeb("stop-managed", "Stop managed ChatGPT Web sidecar")}
                >
                  Stop managed
                </Button>
              )}
              {codexChatGptWeb?.running ? (
                <Button
                  variant="secondary"
                  disabled={!api}
                  onClick={() => runCodexChatGptWeb("show-managed", "Open managed ChatGPT Web browser")}
                >
                  Open browser
                </Button>
              ) : null}
              <Button
                variant="secondary"
                disabled={!api || !codexChatGptWeb?.installed || !codexChatGptWeb?.daemonRunning}
                onClick={() => runCodexChatGptWeb("verify-isolation", "Verify ChatGPT Web isolation")}
              >
                Verify isolation
              </Button>
              <Button
                variant="secondary"
                disabled={!api}
                onClick={() => api && void api.openExternal("https://github.com/miuuyy/codex-chatgpt-web")}
              >
                View source
              </Button>
            </div>
          </section>

          <section className="panel-section">
            <SectionHeading
              title="Codex Auto Resume"
              description="独立 sidecar：原生 Codex Plus 额度恢复后，在原 thread 继续任务；不参与 Router 模型路由、failover 或 compact。"
            />
            <div className="settings-list">
              <div className="setting-row static-row">
                <div>
                  <strong>Sidecar 状态</strong>
                  <small>{codexAutoResume?.installed
                    ? `${codexAutoResume.root}${codexAutoResume.version ? ` · v${codexAutoResume.version}` : ""}`
                    : codexAutoResume?.root || "正在读取安装状态…"}</small>
                </div>
                <Badge tone={codexAutoResume?.running ? "success" : codexAutoResume?.installed ? "neutral" : "warning"}>
                  {codexAutoResume?.running ? "Running" : codexAutoResume?.installed ? "Stopped" : "Not installed"}
                </Badge>
              </div>
              {codexAutoResume?.installed ? (
                <>
                  <div className="setting-row static-row">
                    <div><strong>登录自启</strong><small>由 codex-auto-resume 自己的 Windows Scheduled Task / macOS LaunchAgent 管理。</small></div>
                    <Badge tone={codexAutoResume.autostart ? "success" : "neutral"}>{codexAutoResume.autostart ? "Enabled" : "Disabled"}</Badge>
                  </div>
                  <div className="setting-row static-row">
                    <div>
                      <strong>原生账号作用域</strong>
                      <small>{codexAutoResume.accountFingerprint
                        ? `${codexAutoResume.accountLabel || "当前账号"} · fingerprint ${codexAutoResume.accountFingerprint}`
                        : "当前 live auth 尚未对应到 Control Center Native Account Profile。"}</small>
                    </div>
                    <Badge tone={codexAutoResume.accountGuarded ? "success" : "warning"}>
                      {codexAutoResume.accountGuarded ? "Guarded" : "Unbound"}
                    </Badge>
                  </div>
                  <div className="setting-row static-row">
                    <div>
                      <strong>跟踪线程</strong>
                      <small>线程按 accountFingerprint 隔离；其他账号或未绑定 thread 默认禁止自动续跑。</small>
                    </div>
                    <Badge tone="neutral">{codexAutoResume.activeThreads}/{codexAutoResume.trackedThreads}</Badge>
                  </div>
                  {codexAutoResume.threads.map((thread) => (
                    <div className="setting-row static-row" key={thread.threadId}>
                      <div>
                        <strong>{thread.threadId}</strong>
                        <small>
                          {thread.accountBinding === "current"
                            ? `${thread.accountLabel || "当前账号"} · ${thread.accountFingerprint} · ${thread.status}`
                            : thread.accountBinding === "other"
                              ? `${thread.accountLabel || "其他账号"} · ${thread.accountFingerprint} · blocked`
                              : `UNBOUND · ${thread.status}`}
                        </small>
                      </div>
                      {thread.accountBinding === "unbound" ? (
                        <Button
                          variant="secondary"
                          disabled={!api || !codexAutoResume.accountFingerprint}
                          onClick={() => bindAutoResumeThread(thread.threadId)}
                        >
                          绑定到当前账号
                        </Button>
                      ) : (
                        <Badge tone={thread.accountBinding === "current" ? "success" : "neutral"}>
                          {thread.accountBinding === "current" ? "Current" : "Blocked"}
                        </Badge>
                      )}
                    </div>
                  ))}
                  <div className="setting-row">
                    <div>
                      <strong>自动使用 weekly reset credit</strong>
                      <small>默认关闭。只有你显式打开时，周额度耗尽后才允许 sidecar 自动使用 1 张 reset credit。</small>
                    </div>
                    <Toggle
                      checked={codexAutoResume.autoRedeemWeeklyReset === true}
                      disabled={!api}
                      label="Auto redeem weekly reset credit"
                      onChange={(enabled) => runCodexAutoResume(
                        enabled ? "enable-reset-credit" : "disable-reset-credit",
                        enabled ? "Enable weekly reset-credit auto redeem" : "Disable weekly reset-credit auto redeem",
                      )}
                    />
                  </div>
                </>
              ) : null}
            </div>
            {codexAutoResume?.installed && codexAutoResume.autoRedeemWeeklyReset === true ? (
              <InlineNotice tone="warning" title="Reset credit 自动使用已开启">
                周额度耗尽且账户存在 reset credit 时，sidecar 可能自动使用 1 张。关闭上方开关即可恢复安全默认；这不会影响 5 小时额度恢复后的自动续跑。
              </InlineNotice>
            ) : null}
            {!codexAutoResume?.installed ? (
              <InlineNotice tone="neutral" title="保持独立安装">
                上游仓库当前没有根目录 LICENSE 文件，因此这里不复制其 Python 源码进 Router；安装按钮只会把原仓库克隆到本机 sidecars 目录并调用其公开 CLI。
              </InlineNotice>
            ) : null}
            {codexAutoResumeReport ? (
              <InlineNotice tone="neutral" title="最近一次 Auto Resume 操作">
                {codexAutoResumeReport}
              </InlineNotice>
            ) : null}
            <div className="settings-actions">
              {!codexAutoResume?.installed ? (
                <Button
                  variant="primary"
                  disabled={!api || codexAutoResume?.supported === false}
                  onClick={() => runCodexAutoResume("install", "Install Codex Auto Resume")}
                >
                  Install sidecar
                </Button>
              ) : (
                <>
                  <Button variant="secondary" disabled={!api} onClick={() => runCodexAutoResume("doctor", "Check Codex Auto Resume")}>Run doctor</Button>
                  <Button variant="secondary" disabled={!api} onClick={() => runCodexAutoResume("dry-run", "Dry-run Codex Auto Resume")}>Dry-run scan</Button>
                  {codexAutoResume.autostart ? (
                    <Button variant="ghost" disabled={!api} onClick={() => runCodexAutoResume("disable-autostart", "Disable Codex Auto Resume")}>Disable autostart</Button>
                  ) : (
                    <Button variant="primary" disabled={!api} onClick={() => setConfirmAutoResumeEnable(true)}>Enable autostart</Button>
                  )}
                </>
              )}
              <Button
                variant="secondary"
                disabled={!api}
                onClick={() => api && void api.openExternal("https://github.com/feifeigong/codex-auto-resume")}
              >
                View source
              </Button>
            </div>
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.service.title")} description={t("settings.service.description")} />
            <div className="settings-list">
              <div className="setting-row">
                <div><strong>{t("settings.presence.title")}</strong><small>{t("settings.presence.detail")}</small></div>
                <select
                  aria-label={t("settings.presence.title")}
                  value={presence?.mode || "always"}
                  disabled={!api}
                  onChange={(event) => api && void runAction("Change presence mode", () => api.setPresence(event.target.value as "always" | "follow-codex"))}
                >
                  <option value="always">{t("settings.presence.always")}</option>
                  <option value="follow-codex">{t("settings.presence.followCodex")}</option>
                </select>
              </div>
              <div className="setting-row static-row">
                <div><strong>{t("settings.serviceState.title")}</strong><small>{t("settings.serviceState.detail")}</small></div>
                <Badge tone={health?.ok ? "success" : "danger"}>{health?.ok ? t("settings.serviceState.running") : t("settings.serviceState.offline")}</Badge>
              </div>
            </div>
            <div className="settings-actions">
              <Button variant="secondary" disabled={!api} onClick={() => api && void runAction("Start router service", () => api.controlService("start"))}><Server aria-hidden size={14} strokeWidth={1.7} /> {t("settings.action.start")}</Button>
            </div>
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.context.title")} description={t("settings.context.description")} />
            {economy ? (
              <div className="settings-list">
                <div className="setting-row">
                  <div>
                    <strong>Context Economy v1</strong>
                    <small>仅压缩指定第三方昂贵编码模型的工作上下文：约 100K 开始节流，160–180K 自动 compact；保留模型真实 1M context window，不影响原生 GPT。</small>
                  </div>
                  <Toggle
                    checked={optimisticToggles.value("context-economy", economy.enabled === true)}
                    disabled={!api || economy.environmentOverride === true}
                    label="Context Economy v1"
                    onChange={(enabled) => api && void optimisticToggles.mutate(
                      "context-economy",
                      enabled,
                      "Change context economy",
                      () => api.setContextEconomy(enabled),
                    )}
                  />
                </div>
              </div>
            ) : null}
            {aging ? (
              <>
                <div className="settings-list">
                  <div className="setting-row">
                    <div><strong>{t("settings.context.enable.title")}</strong><small>{t("settings.context.enable.detail")}</small></div>
                    <Toggle checked={toolResultAgingEnabled} disabled={!api || agingLocked} label={t("settings.context.enable.title")} onChange={(enabled) => api && void optimisticToggles.mutate("tool-result-aging", enabled, "Change tool result compaction", () => api.setToolResultAging(enabled))} />
                  </div>
                  <div className="setting-row">
                    <div><strong>{t("settings.context.native.title")}</strong><small>{t("settings.context.native.detail")}</small></div>
                    <Toggle checked={optimisticToggles.value("native-tool-result-aging", aging.nativeEnabled === true)} disabled={!api || agingLocked || !toolResultAgingEnabled} label={t("settings.context.native.title")} onChange={(enabled) => api && void optimisticToggles.mutate("native-tool-result-aging", enabled, "Change native tool result compaction", () => api.setNativeToolResultAging(enabled))} />
                  </div>
                  <div className="setting-row">
                    <div><strong>{t("settings.context.ttl.title")}</strong><small>{t("settings.context.ttl.detail")}</small></div>
                    <select
                      aria-label={t("settings.context.ttl.title")}
                      value={ttlValue}
                      disabled={!api || agingLocked}
                      onChange={(event) => {
                        const raw = event.target.value;
                        const days = raw === "default" ? "default" : Number(raw);
                        if (api) void runAction("Change retention window", () => api.setToolResultRetentionTtl(days));
                      }}
                    >
                      <option value="default">{t("settings.context.ttl.default", { days: RETENTION_DEFAULT_TTL_DAYS })}</option>
                      {ttlChoices.map((days) => <option key={days} value={String(days)}>{t("settings.context.ttl.days", { days })}</option>)}
                      <option value="0">{t("settings.context.ttl.forever")}</option>
                    </select>
                  </div>
                </div>
                {agingLocked ? (
                  <InlineNotice tone="warning" title={t("settings.context.envOverride.title")}>{t("settings.context.envOverride.body")}</InlineNotice>
                ) : null}
                <p className="section-footnote">
                  {hasSavings
                    ? t("settings.context.savings", {
                        tokens: compactNumber(stats?.estimatedTokensSaved),
                        size: formatBytes(stats?.bytesSaved),
                        requests: compactNumber(stats?.requests),
                      })
                    : t("settings.context.noSavings")}
                </p>
              </>
            ) : <InlineNotice tone="neutral" title={t("settings.context.title")}>{t("settings.context.unavailable")}</InlineNotice>}
          </section>
        </div>

        <div className="page-stack">
          <section className="panel-section">
            <SectionHeading title={t("settings.vision.title")} description={t("settings.vision.description")} />
            {bridge ? (
              <>
                <div className="settings-list">
                  <div className="setting-row">
                    <div><strong>{t("settings.vision.enable.title")}</strong><small>{t("settings.vision.enable.detail")}</small></div>
                    <Toggle checked={optimisticToggles.value("vision-bridge", bridge.enabled === true)} disabled={!api} label={t("settings.vision.enable.title")} onChange={(enabled) => api && void optimisticToggles.mutate("vision-bridge", enabled, "Change vision bridge", () => api.setVisionBridgeEnabled(enabled))} />
                  </div>
                  <div className="setting-row">
                    <div><strong>{t("settings.vision.engine.title")}</strong><small>{t("settings.vision.engine.detail")}</small></div>
                    <select
                      aria-label={t("settings.vision.engine.title")}
                      value={selectedEngine}
                      disabled={!api}
                      onChange={(event) => api && void runAction("Change vision engine", () => api.setVisionBridgeEngine(event.target.value))}
                    >
                      {/* No standing "Auto" choice, matching the tray: the ranking behind it
                          scored cost by slug spelling, so it tied across a normal install and
                          resolved alphabetically. It stays visible only while the install is
                          still on it, so the row reports the truth without offering it back. */}
                      {selectedEngine === "auto" ? <option value="auto">{t("settings.vision.engine.auto", { name: bridge.resolvedEngineName || bridge.resolvedEngine || "—" })}</option> : null}
                      {unlistedEngine ? <option value={unlistedEngine.slug}>{unlistedEngine.displayName}</option> : null}
                      {paidEngines.length ? (
                        <optgroup label={t("settings.vision.engine.paid")}>
                          {paidEngines.map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                        </optgroup>
                      ) : null}
                      {nativeEngines.length ? (
                        <optgroup label={t("settings.vision.engine.native")}>
                          {nativeEngines.map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                        </optgroup>
                      ) : null}
                      {bridge.local ? <option value="local">{t("settings.vision.engine.local", { name: bridge.local.model || "runtime" })}</option> : null}
                    </select>
                  </div>
                  <div className="setting-row">
                    <div><strong>{t("settings.vision.effort.title")}</strong><small>{effortOptions.length ? t("settings.vision.effort.detail") : t("settings.vision.effort.none")}</small></div>
                    <select
                      aria-label={t("settings.vision.effort.title")}
                      value={selectedEffort}
                      disabled={!api || !effortOptions.length}
                      onChange={(event) => api && void runAction("Change vision effort", () => api.setVisionBridgeEffort(event.target.value))}
                    >
                      <option value="default">{t("settings.vision.effort.default")}</option>
                      {effortOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                    </select>
                  </div>
                </div>
                <div className="surface-summary">
                  <Eye aria-hidden size={20} strokeWidth={1.6} />
                  <div><strong>{bridge.resolvedEngineName || bridge.resolvedEngine || bridge.engine || "—"}</strong><small>{t("settings.vision.localNote")}</small></div>
                </div>
              </>
            ) : <InlineNotice tone="neutral" title={t("settings.vision.title")}>{t("settings.vision.unavailable")}</InlineNotice>}
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.desktop.title")} description={t("settings.desktop.description")} />
            <div className="surface-summary">
              <AppWindow aria-hidden size={20} strokeWidth={1.6} />
              <div><strong>{t("settings.desktop.tray.title")}</strong><small>{t("settings.desktop.tray.detail")}</small></div>
            </div>
            <div className="settings-actions">
              <Button variant="secondary" disabled={!api || trayControlsUnavailable} onClick={() => api && void runAction("Enable desktop tray", () => api.controlTray("enable"))}>{t("settings.desktop.enable")}</Button>
              <Button variant="secondary" disabled={!api || trayControlsUnavailable} onClick={() => api && void runAction("Restart desktop tray", () => api.controlTray("restart"))}>{t("settings.desktop.restart")}</Button>
              <Button variant="ghost" disabled={!api || trayControlsUnavailable} onClick={() => setConfirmTrayDisable(true)}>{t("settings.desktop.disable")}</Button>
            </div>
            {trayControlsUnavailable ? (
              <InlineNotice tone="neutral" title={t("settings.desktop.unavailable.title")}>
                {t("settings.desktop.unavailable.body")}
              </InlineNotice>
            ) : null}
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.appearance.title")} description={t("settings.appearance.description")} />
            <div className="theme-picker" role="radiogroup" aria-label={t("settings.appearance.aria")}>
              <button role="radio" aria-checked={theme === "light"} className={theme === "light" ? "is-active" : ""} onClick={() => onTheme("light")}><Sun aria-hidden size={16} strokeWidth={1.7} /><span><strong>{t("settings.appearance.light")}</strong><small>{t("settings.appearance.lightDetail")}</small></span></button>
              <button role="radio" aria-checked={theme === "dark"} className={theme === "dark" ? "is-active" : ""} onClick={() => onTheme("dark")}><Moon aria-hidden size={16} strokeWidth={1.7} /><span><strong>{t("settings.appearance.dark")}</strong><small>{t("settings.appearance.darkDetail")}</small></span></button>
            </div>
            <div className="settings-list">
              <div className="setting-row">
                <div><strong>{t("settings.language.title")}</strong><small>{t("settings.language.detail")}</small></div>
                <select
                  aria-label={t("settings.language.aria")}
                  value={language}
                  onChange={(event) => onLanguage(event.target.value as LanguageId)}
                >
                  {LANGUAGE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </div>
              <div className="setting-row">
                <div><strong>{t("settings.scale.title")}</strong><small>{t("settings.scale.detail")}</small></div>
                <select
                  aria-label={t("settings.scale.aria")}
                  value={uiScale}
                  onChange={(event) => onUiScale(Number(event.target.value) as UiScale)}
                >
                  {UI_SCALE_OPTIONS.map((scale) => <option key={scale} value={scale}>{scale}%{scale === 100 ? ` · ${t("settings.scale.default")}` : ""}</option>)}
                </select>
              </div>
            </div>
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.maintenance.title")} description={t("settings.maintenance.description")} />
            <div className="surface-summary">
              <Wrench aria-hidden size={20} strokeWidth={1.6} />
              <div><strong>{t("settings.maintenance.repairTitle")}</strong><small>{t("settings.maintenance.footnote")}</small></div>
            </div>
            <div className="settings-actions">
              <Button variant="primary" disabled={!api || repairing} onClick={() => setConfirmRepair(true)}>
                {repairing ? t("settings.maintenance.fixRunning") : t("settings.maintenance.fix")}
              </Button>
            </div>
            {repairReport && repairReport.ok ? (
              <InlineNotice tone="success" title={t("settings.maintenance.fixDone")}>
                {t("settings.maintenance.fixDoneDetail")}
              </InlineNotice>
            ) : null}
            {repairFailures.length ? (
              <InlineNotice tone="danger" title={t("settings.maintenance.fixIncomplete")}>
                {/* Repair ran; these checks still fail. Naming them with their
                    own remedy is the whole point of showing the report -- a
                    bare "it failed" would send the user back to the terminal
                    the button exists to replace. */}
                {repairFailures.map((check) => `${check.name}: ${check.detail || ""}${check.fix ? ` — ${check.fix}` : ""}`).join(" · ")}
              </InlineNotice>
            ) : null}
            <InlineNotice tone="neutral" title={t("settings.maintenance.update")}>
              {t("settings.maintenance.updateNote")}
            </InlineNotice>
          </section>
        </div>
      </div>

      <Dialog
        open={accountEditor !== null}
        title={accountEditor?.mode === "rename" ? "重命名 ChatGPT 账号" : "添加 ChatGPT 账号"}
        description={accountEditor?.mode === "rename"
          ? "只修改 Control Center 中的显示名称，不改变登录身份。"
          : "新账号始终使用隔离 CODEX_HOME。默认启动官方 Codex 浏览器 OAuth；你可以把同一授权地址复制到 Chrome 无痕窗口。若最后 localhost 回调打不开，再把完整回调 URL 粘贴回 Control Center。"}
        onClose={() => setAccountEditor(null)}
      >
        <div className="credential-form">
          <input
            aria-label="ChatGPT 账号名称"
            autoFocus
            maxLength={64}
            value={accountEditor?.value || ""}
            onChange={(event) => setAccountEditor((current) => current ? { ...current, value: event.target.value } : current)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !accountEditor?.value.trim() || !api) return;
              event.preventDefault();
              const editor = accountEditor;
              setAccountEditor(null);
              if (editor.mode === "rename" && editor.id) {
                runCodexAccountAction("Rename ChatGPT account", () => api.renameCodexAccount(editor.id!, editor.value.trim()));
              } else {
                runCodexAccountAction("Start ChatGPT browser login", () => api.startCodexAccountBrowserLogin(editor.value.trim()));
              }
            }}
          />
          <p>
            {accountEditor?.mode === "rename"
              ? "不会读取、显示或重写任何密码和 token。"
              : "两种登录都由官方 Codex CLI 负责；Control Center 不接收密码。浏览器 OAuth 支持 CLIProxyAPI 风格的手工 localhost 回调提交；设备代码只作为 localhost 仍不可用时的备用。"}
          </p>
        </div>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setAccountEditor(null)}>取消</Button>
          {accountEditor?.mode === "add" ? (
            <Button
              variant="secondary"
              disabled={!api || !accountEditor?.value.trim()}
              onClick={() => {
                if (!api || !accountEditor?.value.trim()) return;
                const editor = accountEditor;
                setAccountEditor(null);
                runCodexAccountAction("Start ChatGPT device login", () => api.startCodexAccountDeviceLogin(editor.value.trim()));
              }}
            >
              设备代码登录（备用）
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={!api || !accountEditor?.value.trim()}
            onClick={() => {
              if (!api || !accountEditor?.value.trim()) return;
              const editor = accountEditor;
              setAccountEditor(null);
              if (editor.mode === "rename" && editor.id) {
                runCodexAccountAction("Rename ChatGPT account", () => api.renameCodexAccount(editor.id!, editor.value.trim()));
              } else {
                runCodexAccountAction("Start ChatGPT browser login", () => api.startCodexAccountBrowserLogin(editor.value.trim()));
              }
            }}
          >
            {accountEditor?.mode === "rename" ? "保存名称" : "浏览器 OAuth / 无痕登录（推荐）"}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={pendingAccountSwitch !== null}
        title="切换 ChatGPT 原生账号？"
        description="优先支持 Native GPT 未完成任务在同一个 Codex thread 中接力；Router 不重启。"
        onClose={() => {
          setPendingAccountSwitch(null);
          setHandoffCandidate(null);
        }}
      >
        <p className="dialog-copy">
          切换到 <strong>{pendingAccountSwitch?.label}</strong> 前，请完全退出 Codex Desktop。账号切换不会删除本地 thread/history。若选择“切换并接力”，Control Center 会为最近的 Native GPT thread 写入一次显式 A→B handoff 授权，切换账号后重新打开同一个 thread；Router 只在新账号真正发送下一条消息时完成 ownership 转移。
        </p>
        {handoffLoading ? (
          <InlineNotice tone="neutral" title="正在查找最近的 Native GPT 对话">
            只查找本机可继续的 root thread，不读取或显示聊天正文。
          </InlineNotice>
        ) : handoffCandidate ? (
          <InlineNotice tone="neutral" title="可接力的最近 Native GPT 对话">
            <strong>{handoffCandidate.title}</strong>
            <div>
              {handoffCandidate.workspaceLabel || handoffCandidate.workspace || "未知工作区"}
              {handoffCandidate.model ? ` · ${handoffCandidate.model}` : ""}
              {handoffCandidate.updatedAt ? ` · ${new Date(handoffCandidate.updatedAt).toLocaleString()}` : ""}
            </div>
            <div>接力会保留同一个 thread ID、已有消息历史和工作区；不会把 ChatGPT Web / 第三方 Provider thread 当作 Native 账号接力。</div>
          </InlineNotice>
        ) : (
          <InlineNotice tone="neutral" title="未找到可确认的 Native GPT thread">
            仍可只切换账号。若要接力其它旧 thread，可在 Codex 中手工重新打开；未显式授权的跨账号 thread 不会由 Control Center 自动迁移。
          </InlineNotice>
        )}
        <p className="dialog-copy">
          Auto Resume 只是附加能力：如果已安装，会在接力准备后尝试同步 thread binding；即使 Auto Resume 未安装或恢复失败，也不会阻止 Native thread 接力。Router 4202/4203、第三方模型、ChatGPT Web 和 config.toml 全程保持不动。
        </p>
        <div className="dialog-actions">
          <Button
            variant="secondary"
            onClick={() => {
              setPendingAccountSwitch(null);
              setHandoffCandidate(null);
            }}
          >
            取消
          </Button>
          <Button
            variant="secondary"
            disabled={!api || !pendingAccountSwitch}
            onClick={() => {
              if (!api || !pendingAccountSwitch) return;
              const profile = pendingAccountSwitch;
              setPendingAccountSwitch(null);
              setHandoffCandidate(null);
              runCodexAccountAction("Switch ChatGPT account", () => api.switchCodexAccount(profile.id));
            }}
          >
            仅切换账号
          </Button>
          {handoffCandidate ? (
            <Button
              variant="primary"
              disabled={!api || !pendingAccountSwitch}
              onClick={() => {
                if (!api || !pendingAccountSwitch || !handoffCandidate) return;
                const profile = pendingAccountSwitch;
                const threadId = handoffCandidate.id;
                setPendingAccountSwitch(null);
                setHandoffCandidate(null);
                runCodexAccountAction(
                  "Switch ChatGPT account and hand off thread",
                  () => api.switchCodexAccount(profile.id, { handoffThreadId: threadId }),
                );
              }}
            >
              切换并接力此对话
            </Button>
          ) : null}
        </div>
      </Dialog>

      <Dialog
        open={pendingAccountDelete !== null}
        title="删除 ChatGPT 账号 Profile？"
        description="只删除 Control Center 保存的该账号 Profile，不注销 ChatGPT，也不改变 Router。"
        onClose={() => setPendingAccountDelete(null)}
      >
        <p className="dialog-copy">
          删除 <strong>{pendingAccountDelete?.label}</strong> 的本地 Profile？当前正在使用的账号不能删除；以后需要时可再次通过官方 Codex 登录添加。
        </p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setPendingAccountDelete(null)}>取消</Button>
          <Button
            variant="danger"
            disabled={!api || !pendingAccountDelete}
            onClick={() => {
              if (!api || !pendingAccountDelete) return;
              const profile = pendingAccountDelete;
              setPendingAccountDelete(null);
              runCodexAccountAction("Delete ChatGPT account", () => api.deleteCodexAccount(profile.id));
            }}
          >
            删除 Profile
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={confirmSessionSharing}
        title={t("settings.chatgptSession.confirm.title")}
        description={t("settings.chatgptSession.confirm.description")}
        onClose={() => setConfirmSessionSharing(false)}
      >
        <p className="dialog-copy">{t("settings.chatgptSession.confirm.body")}</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setConfirmSessionSharing(false)}>{t("settings.desktop.confirm.cancel")}</Button>
          <Button variant="primary" onClick={() => {
            setConfirmSessionSharing(false);
            if (api) void runAction(t("settings.chatgptSession.action.enable"), () => api.setChatGptSessionSharing(true));
          }}>{t("settings.chatgptSession.confirm.enable")}</Button>
        </div>
      </Dialog>

      <Dialog
        open={confirmAutoResumeEnable}
        title="Enable Codex Auto Resume?"
        description="This starts the external watcher now and at future logins."
        onClose={() => setConfirmAutoResumeEnable(false)}
      >
        <p className="dialog-copy">
          启用后由 sidecar 自己监测原生 Codex 额度并续跑原 thread；它不会触发 Router fallback，也不会替换当前模型。Control Center 会在启用前再次强制保持 weekly reset credit 自动使用为关闭状态，除非你之后在上方明确开启。
        </p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setConfirmAutoResumeEnable(false)}>{t("settings.desktop.confirm.cancel")}</Button>
          <Button variant="primary" onClick={() => {
            setConfirmAutoResumeEnable(false);
            runCodexAutoResume("enable-autostart", "Enable Codex Auto Resume");
          }}>Enable autostart</Button>
        </div>
      </Dialog>

      <Dialog
        open={confirmRepair}
        title={t("settings.maintenance.confirm.title")}
        description={t("settings.maintenance.confirm.description")}
        onClose={() => setConfirmRepair(false)}
      >
        <p className="dialog-copy">{t("settings.maintenance.confirm.body")}</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setConfirmRepair(false)}>{t("settings.desktop.confirm.cancel")}</Button>
          <Button variant="primary" onClick={() => {
            setConfirmRepair(false);
            void runRepair();
          }}>{t("settings.maintenance.fix")}</Button>
        </div>
      </Dialog>

      <Dialog open={confirmTrayDisable} title={t("settings.desktop.confirm.title")} description={t("settings.desktop.confirm.description")} onClose={() => setConfirmTrayDisable(false)}>
        <p className="dialog-copy">{t("settings.desktop.confirm.body")}</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setConfirmTrayDisable(false)}>{t("settings.desktop.confirm.cancel")}</Button>
          <Button variant="danger" disabled={trayControlsUnavailable} onClick={() => {
            setConfirmTrayDisable(false);
            if (api) void runAction("Disable desktop tray", () => api.controlTray("disable"));
          }}>{t("settings.desktop.disable")}</Button>
        </div>
      </Dialog>
    </>
  );
}
