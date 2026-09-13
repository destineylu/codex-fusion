import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AppWindow,
  BookOpen,
  Boxes,
  CheckCircle2,
  Download,
  ExternalLink,
  Route,
  Search,
  ShieldAlert,
  SquareTerminal,
} from "lucide-react";
import { Badge, Button, InlineNotice, PageHeader, PanelSkeleton, SectionHeading, StatStrip, Toggle } from "../components";
import type { CodexSkillControlSnapshot, HarnessDescriptor, HarnessSnapshot, RouterControlApi, RouterTarget } from "../types";
import "./local-harness-context.css";

type RunAction = (label: string, action: () => Promise<unknown>) => Promise<void>;

interface HarnessPageProps {
  target?: RouterTarget;
  api?: RouterControlApi;
  refreshing: boolean;
  onRefresh: () => void;
  runAction: RunAction;
}

export function HarnessPage({ target, api, refreshing, onRefresh, runAction }: HarnessPageProps) {
  const [snapshot, setSnapshot] = useState<HarnessSnapshot>();
  const [error, setError] = useState<string>();
  const [skillControl, setSkillControl] = useState<CodexSkillControlSnapshot>();
  const [skillError, setSkillError] = useState<string>();
  const [skillSearch, setSkillSearch] = useState("");
  const [skillBusy, setSkillBusy] = useState<string>();
  const loadHarnesses = useCallback(async () => {
    if (!api) return;
    try {
      setSnapshot(await api.getHarnesses());
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Harness detection failed.");
    }
  }, [api]);

  const loadSkillControl = useCallback(async () => {
    if (!api) return;
    try {
      setSkillControl(await api.getCodexSkillControl());
      setSkillError(undefined);
    } catch (reason) {
      setSkillError(reason instanceof Error ? reason.message : "Codex skill detection failed.");
    }
  }, [api]);

  useEffect(() => { void loadHarnesses(); }, [loadHarnesses]);
  useEffect(() => { void loadSkillControl(); }, [loadSkillControl]);

  const codex = snapshot?.harnesses.find((harness) => harness.id === "codex");
  const deepcode = snapshot?.harnesses.find((harness) => harness.id === "deepcode");
  const deepseekModels = useMemo(
    () => (target?.models ?? []).filter((model) => (model.enabled || model.native) && `${model.provider}/${model.slug}`.toLowerCase().includes("deepseek")),
    [target],
  );
  const provenModels = target?.models.filter((model) => model.enabled && model.multiAgentVersion === "v2") ?? [];
  const filteredSkills = useMemo(() => {
    const query = skillSearch.trim().toLowerCase();
    const skills = skillControl?.skills ?? [];
    if (!query) return skills;
    return skills.filter((skill) =>
      `${skill.name} ${skill.source} ${skill.description || ""} ${skill.category}`.toLowerCase().includes(query)
    );
  }, [skillControl?.skills, skillSearch]);
  const skillGroups = useMemo(() => {
    const definitions = [
      { key: "core", title: "Core", description: "Kept in Light v2 because these skills provide coding, Router, browser, document, memory, or system capabilities." },
      { key: "specialized", title: "Specialized", description: "Off by default in Light v2. Turn on only the workflow needed for the current task." },
      { key: "invalid", title: "Invalid", description: "Codex cannot load these SKILL.md files, so their current fixed-prompt contribution is zero." },
      { key: "plugin-cache", title: "Plugin Cache", description: "Skills found in the local plugin cache. Only active plugins/apps contribute to the current prompt estimate." },
    ] as const;
    return definitions.map((definition) => {
      const skills = filteredSkills.filter((skill) => skill.category === definition.key);
      return {
        ...definition,
        skills,
        estimatedPromptTokens: skills.reduce((sum, skill) => sum + skill.estimatedPromptTokens, 0),
      };
    });
  }, [filteredSkills]);

  const refresh = () => {
    onRefresh();
    void loadHarnesses();
    void loadSkillControl();
  };
  const act = async (label: string, action: () => Promise<unknown>) => {
    await runAction(label, action);
    await loadHarnesses();
  };
  const changeContextMode = async (mode: "light" | "full") => {
    if (!api || skillBusy) return;
    setSkillBusy(`mode:${mode}`);
    try {
      await runAction(mode === "light" ? "Enable Codex Light v2" : "Enable Codex Full", () => api.setCodexContextMode(mode));
      await loadSkillControl();
    } finally {
      setSkillBusy(undefined);
    }
  };
  const changeSkill = async (skillName: string, enabled: boolean) => {
    if (!api || skillBusy || skillControl?.mode !== "light") return;
    setSkillBusy(skillName);
    try {
      await runAction(`${enabled ? "Enable" : "Disable"} skill ${skillName}`, () => api.setCodexSkillException(skillName, enabled));
      await loadSkillControl();
    } finally {
      setSkillBusy(undefined);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Coding environments"
        title="Harness"
        description="Launch each coding environment in the surface it actually supports."
        onRefresh={refresh}
        refreshing={refreshing}
      />
      <StatStrip items={[
        { label: "Detected", value: snapshot?.harnesses.filter((harness) => harness.cliInstalled || harness.appInstalled).length ?? 0, detail: "Supported harnesses" },
        { label: "Codex app", value: codex?.appInstalled ? "Ready" : "Not found", detail: codex?.cliVersion || "Desktop task links" },
        { label: "DeepSeek routes", value: deepseekModels.length, detail: target?.enabledProviders.includes("deepseek") ? "Provider connected" : "Via enabled providers" },
        { label: "Subagent relay", value: provenModels.length, detail: "Proven v2 models" },
      ]} />

      {error ? <InlineNotice tone="warning" title="Harness detection is incomplete">{error}</InlineNotice> : null}

      <div className="lhc-harness-grid">
        {!snapshot && !error ? <PanelSkeleton label="Detecting harnesses" variant="cards" count={2} /> : null}
        {codex ? (
          <HarnessCard
            harness={codex}
            accent="codex"
            status={codex.cliInstalled ? "CLI detected" : codex.appInstalled ? "App detected" : "Not installed"}
            facts={[
              codex.appInstalled ? "Desktop task links available" : "Desktop app not detected",
              codex.cliInstalled ? codex.cliVersion || "Codex CLI available" : "Codex CLI not detected",
              `${target?.models.filter((model) => model.enabled || model.native).length ?? 0} routed models available`,
            ]}
            actions={
              <>
                {codex.appInstalled ? (
                  <Button variant="primary" disabled={!api} onClick={() => api && void act("Open Codex app", () => api.launchHarness("codex", "app"))}>
                    <AppWindow aria-hidden size={14} strokeWidth={1.7} /> Open app
                  </Button>
                ) : (
                  <Button variant="primary" disabled={!api} onClick={() => api && void act("Open official Codex download", () => api.openExternal(codex.docsUrl))}>
                    <Download aria-hidden size={14} strokeWidth={1.7} /> Get Codex
                  </Button>
                )}
                <Button variant="secondary" disabled={!api || !codex.cliInstalled || !snapshot?.terminalAvailable} onClick={() => api && void act("Open Codex terminal", () => api.launchHarness("codex", "terminal"))}>
                  <SquareTerminal aria-hidden size={14} strokeWidth={1.7} /> Open terminal
                </Button>
                <Button variant="ghost" disabled={!api} onClick={() => api && void act("Open Codex documentation", () => api.openExternal(codex.docsUrl))}>
                  <BookOpen aria-hidden size={14} strokeWidth={1.7} /> Docs
                </Button>
              </>
            }
          />
        ) : null}

        {deepcode ? (
          <HarnessCard
            harness={deepcode}
            accent="deepcode"
            status={deepcode.cliInstalled ? "CLI detected" : "Optional install"}
            facts={[
              deepcode.configured ? "Settings file detected" : "Configuration not detected",
              deepcodeModelsLabel(deepseekModels.length),
              "Sessions resume in a real terminal",
            ]}
            notice="Deep Code is a third-party reference integration listed by DeepSeek. It is not an official DeepSeek desktop app."
            actions={
              <>
                {deepcode.cliInstalled ? (
                  <Button variant="primary" disabled={!api || !snapshot?.terminalAvailable} onClick={() => api && void act("Open Deep Code terminal", () => api.launchHarness("deepcode", "terminal"))}>
                    <SquareTerminal aria-hidden size={14} strokeWidth={1.7} /> Open terminal
                  </Button>
                ) : (
                  <Button variant="primary" disabled={!api || !deepcode.canInstall} title={deepcode.installRequirement} onClick={() => api && void act("Open Deep Code installer", () => api.installHarness("deepcode"))}>
                    <Download aria-hidden size={14} strokeWidth={1.7} /> Install in Terminal
                  </Button>
                )}
                <Button variant="ghost" disabled={!api} onClick={() => api && void act("Open Deep Code reference", () => api.openExternal(deepcode.docsUrl))}>
                  <ExternalLink aria-hidden size={14} strokeWidth={1.7} /> Reference
                </Button>
              </>
            }
          />
        ) : null}
      </div>

      <section className="panel-section lhc-skill-control">
        <SectionHeading
          title="Codex Skills"
          description="Keep Light v2 lean, temporarily enable only the specialized skills you need, or switch the whole harness to Full."
          action={
            <div className="lhc-skill-mode-actions" aria-label="Codex context mode">
              <Button variant={skillControl?.mode === "light" ? "primary" : "secondary"} disabled={!api || Boolean(skillBusy) || skillControl?.supported === false} onClick={() => void changeContextMode("light")}>Light v2</Button>
              <Button variant={skillControl?.mode === "full" ? "primary" : "secondary"} disabled={!api || Boolean(skillBusy) || skillControl?.supported === false} onClick={() => void changeContextMode("full")}>Full</Button>
            </div>
          }
        />
        {skillError ? <InlineNotice tone="warning" title="Codex skill state is incomplete">{skillError}</InlineNotice> : null}
        {skillControl && !skillControl.supported ? (
          <InlineNotice tone="neutral" title="Codex skill control unavailable">{skillControl.why || "The local switch-codex-mode.ps1 script is unavailable."}</InlineNotice>
        ) : null}
        {skillControl?.supported ? (
          <>
            <div className="lhc-skill-summary">
              <div>
                <span>Context mode</span>
                <strong>{skillControl.modeLabel || "Unknown"}</strong>
                <small>{skillControl.model ? `Model: ${skillControl.model}` : "Light v2 is the one-time default; later manual choices are preserved."}</small>
              </div>
              <div>
                <span>Estimated skill prompt</span>
                <strong>~{(skillControl.estimatedPromptTokens ?? 0).toLocaleString()} tok</strong>
                <small>Metadata-only estimate; actual Codex budgeting and prompt caching can differ.</small>
              </div>
              <div>
                <span>Specialized</span>
                <strong>{skillControl.specializedSkills ?? 0}</strong>
                <small>{skillControl.mode === "light" ? `${skillControl.temporaryExceptions ?? 0} temporarily enabled · ${skillControl.disabledEntries ?? 0} Light disable entries` : "Available in Full; switch to Light to control individually"}</small>
              </div>
              <div>
                <span>Inventory health</span>
                <strong>{skillControl.invalidSkills ?? 0} invalid</strong>
                <small>{skillControl.coreSkills ?? 0} core · {skillControl.pluginCacheSkills ?? 0} plugin-cache entries</small>
              </div>
            </div>
            {skillControl.defaultedToLight ? (
              <InlineNotice tone="success" title="Default context changed to Light v2">
                The one-time Control Center default was applied. Full remains available and later manual mode choices are preserved.
              </InlineNotice>
            ) : null}
            <InlineNotice tone="neutral" title={skillControl.mode === "light" ? "Light v2 keeps core capabilities" : "Full mode is active"}>
              {skillControl.mode === "light"
                ? "Memory, Apps framework, Node REPL, Browser / Computer Use, Word / PDF / PPT / Excel and core coding skills stay available. Specialized skills are off unless temporarily enabled."
                : "All valid specialized skills are available in Full. The inventory below also separates invalid files and cache-only plugin skills so they are not confused with prompt contributors."}
            </InlineNotice>
            <div className="lhc-skill-toolbar">
              <label className="search-field">
                <Search aria-hidden size={14} strokeWidth={1.7} />
                <input value={skillSearch} onChange={(event) => setSkillSearch(event.target.value)} placeholder="Search all Codex skills" aria-label="Search all Codex skills" />
              </label>
              <span>{filteredSkills.length} of {skillControl.skills.length}</span>
            </div>
            <div className="lhc-skill-groups" aria-label="Codex skill inventory">
              {skillGroups.map((group) => (
                <section className="lhc-skill-group" key={group.key} data-category={group.key}>
                  <header>
                    <div>
                      <strong>{group.title}</strong>
                      <small>{group.description}</small>
                    </div>
                    <span>{group.skills.length} skills · ~{group.estimatedPromptTokens.toLocaleString()} tok now</span>
                  </header>
                  {group.skills.length ? (
                    <div className="lhc-skill-grid">
                      {group.skills.map((skill) => (
                        <div className="lhc-skill-row" key={skill.path || `${skill.category}:${skill.name}:${skill.source}`} data-temporary={skill.temporary ? "true" : "false"} data-category={skill.category}>
                          <div className="lhc-skill-copy">
                            <strong>{skill.name}</strong>
                            <small>{skill.description || skill.validationMessage || skill.source}</small>
                            <small className="lhc-skill-source">{skill.source}</small>
                          </div>
                          <span className="lhc-skill-tokens" title="Estimated metadata contribution to the fixed prompt">
                            {skill.estimatedPromptTokens > 0
                              ? `~${skill.estimatedPromptTokens} tok`
                              : skill.estimatedEnabledPromptTokens > 0
                                ? `0 now · ~${skill.estimatedEnabledPromptTokens} on`
                                : "0 tok"}
                          </span>
                          {skill.temporary ? (
                            <Badge tone="accent">Temporary</Badge>
                          ) : skill.category === "invalid" ? (
                            <Badge tone="danger">Invalid</Badge>
                          ) : (
                            <Badge tone={skill.enabled ? "success" : "neutral"}>{skill.state}</Badge>
                          )}
                          {skill.category === "specialized" ? (
                            <Toggle
                              checked={skill.enabled}
                              disabled={!api || Boolean(skillBusy) || skillControl.mode !== "light"}
                              label={`${skill.name} specialized skill`}
                              onChange={(enabled) => void changeSkill(skill.name, enabled)}
                            />
                          ) : (
                            <span className="lhc-skill-readonly">{skill.category === "plugin-cache" ? "Plugin/App" : "Read only"}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : <div className="lhc-skill-empty">No matching skills in this category.</div>}
                </section>
              ))}
            </div>
          </>
        ) : !skillError ? <PanelSkeleton label="Reading Codex skill profile" variant="list" count={4} /> : null}
      </section>

      <section className="panel-section">
        <SectionHeading title="Routing shared by the harnesses" description="The router exposes models to Codex. Deep Code keeps its own provider settings and session store." />
        <div className="lhc-continuity-map">
          <article>
            <Route aria-hidden size={18} strokeWidth={1.7} />
            <div><strong>Codex Router catalog</strong><small>{target?.models.filter((model) => model.enabled || model.native).length ?? 0} models are available to new Codex tasks.</small></div>
            <Badge tone={target?.active ? "success" : "neutral"}>{target?.active ? "Active" : "Inactive"}</Badge>
          </article>
          <article>
            <Boxes aria-hidden size={18} strokeWidth={1.7} />
            <div><strong>DeepSeek models</strong><small>{deepseekModels.length ? deepseekModels.map((model) => model.displayName).slice(0, 3).join(", ") : "Connect a DeepSeek-capable provider to expose models in Codex."}</small></div>
            <Badge tone={deepseekModels.length ? "success" : "neutral"}>{deepseekModels.length ? `${deepseekModels.length} ready` : "None"}</Badge>
          </article>
          <article>
            <ShieldAlert aria-hidden size={18} strokeWidth={1.7} />
            <div><strong>Credential boundary</strong><small>The control center never copies a credential from one harness into another.</small></div>
            <Badge tone="accent">Isolated</Badge>
          </article>
        </div>
      </section>

    </>
  );
}

function HarnessCard({ harness, accent, status, facts, notice, actions }: {
  harness: HarnessDescriptor;
  accent: "codex" | "deepcode";
  status: string;
  facts: string[];
  notice?: string;
  actions: ReactNode;
}) {
  return (
    <section className={`lhc-harness-card is-${accent}`}>
      <header>
        <span className="lhc-harness-mark" aria-hidden>{accent === "codex" ? <Boxes size={21} strokeWidth={1.6} /> : <Route size={21} strokeWidth={1.6} />}</span>
        <div><h2>{harness.displayName}</h2><p>{harness.description}</p></div>
        <Badge tone={harness.cliInstalled || harness.appInstalled ? "success" : "neutral"}>{status}</Badge>
      </header>
      <div className="lhc-harness-facts">
        {facts.map((fact) => <div key={fact}><CheckCircle2 aria-hidden size={13} strokeWidth={1.8} /><span>{fact}</span></div>)}
      </div>
      {notice ? <p className="lhc-harness-notice">{notice}</p> : null}
      <footer>{actions}</footer>
    </section>
  );
}

function deepcodeModelsLabel(count: number): string {
  if (!count) return "No DeepSeek route is enabled in Codex";
  return `${count} DeepSeek model${count === 1 ? "" : "s"} available in Codex`;
}
