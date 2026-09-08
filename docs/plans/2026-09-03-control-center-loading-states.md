# Control Center Loading States Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Precisely backport upstream commit `f35ac504a1f50ca771dca4529f29033bef7445e7` onto the current `v0.5.1` checkout so Control Center loading states do not block independent pages.

**Architecture:** Preserve the current v0.5.1 Router backend, providers, proxy, and service unchanged. Apply only the upstream loading/readiness implementation and its regression coverage, resolving any context-only hunk offsets without changing behavior.

**Tech Stack:** TypeScript/React, Vite, Electron, Node `node:test`, Playwright 1.62.1, npm lockfiles.

---

### Task 1: Audit the upstream patch

**Files:**
- Read: `apps/control-center/src/App.tsx`
- Read: `apps/control-center/src/pages/DashboardPage.tsx`
- Read: `apps/control-center/src/pages/LocalPage.tsx`
- Read: `apps/control-center/src/pages/ModelsPage.tsx`
- Read: `apps/control-center/src/pages/StatusPage.tsx`
- Read: `apps/control-center/src/pages/UsagePage.tsx`
- Read: `apps/control-center/src/pages/dashboard.css`
- Read: `apps/control-center/src/pages/providers-models.css`
- Read: `apps/control-center/src/pages/usage-status.css`
- Read: `apps/control-center/src/types.ts`
- Read: `apps/control-center/test/renderer.test.mjs`
- Read: `test/control-center-electron.test.mjs`

**Step 1:** Inspect `git show --stat` and complete binary diff for `f35ac504`.

**Step 2:** Compare every hunk against `v0.5.1`, documenting clean applicability or required context-only offset.

### Task 2: Apply only f35ac504

**Files:** The 12 files listed in Task 1.

**Step 1:** Create a repair anchor ref before edits.

**Step 2:** Apply the exact upstream patch without cherry-picking and without applying `03b9d9f8` or `b7255f59`.

**Step 3:** Confirm no Router backend, provider, proxy, service, lockfile, or legacy GUI files changed.

### Task 3: Verify the backport

**Step 1:** Run `npm run check` from `apps/control-center`.

**Step 2:** Run the minimal renderer test with Node's supported `--test-name-pattern` filter.

**Step 3:** Run the full `npm test` suite.

**Step 4:** Stop immediately on any failure; do not install the tray or add later upstream commits.

**Step 5:** Report changed files, exact correspondence/manual adaptation, all test results, whether later ordering fixes are still needed, Git status, and whether `tray install` is authorized.
