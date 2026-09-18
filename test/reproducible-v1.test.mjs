import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("reproducible v1 release invariants pass", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "reproducible-v1-check.mjs")], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /14\/14 reproducibility checks passed\./);
});
