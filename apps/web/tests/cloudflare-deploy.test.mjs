import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(testDirectory, "../../..");
const workflow = readFileSync(
  path.join(repositoryDirectory, ".github/workflows/deploy-web.yml"),
  "utf8",
);

test("deploys only a successful Hookemon CI push on main", () => {
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows:\s*\["Hookemon CI"\]/);
  assert.match(workflow, /branches:\s*\[main\]/);
  assert.match(workflow, /types:\s*\[completed\]/);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.event == 'push'/);
  assert.match(workflow, /workflow_run\.head_branch == 'main'/);
  assert.doesNotMatch(workflow, /^\s+pull_request:/m);
});

test("checks out and deploys the exact CI-approved revision", () => {
  assert.match(workflow, /ref:\s*\$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(workflow, /node-version:\s*22\.13\.0/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /verify-cloudflare-deploy\.mjs config dist\/server\/wrangler\.json/);
  assert.match(
    workflow,
    /npx --no-install wrangler versions upload\s+--config dist\/server\/wrangler\.json/,
  );
  assert.match(workflow, /verify-cloudflare-deploy\.mjs version-id/);
  assert.match(
    workflow,
    /npx --no-install wrangler versions deploy\s+"\$\{\{ steps\.worker-version\.outputs\.version_id \}\}@100%"/,
  );
  assert.match(workflow, /--yes/);
  assert.doesNotMatch(workflow, /wrangler triggers deploy/);
  assert.match(workflow, /GitHub \$\{DEPLOY_SHA\}/);
  assert.match(workflow, /WRANGLER_OUTPUT_FILE_PATH/);
  assert.match(workflow, /verify-cloudflare-deploy\.mjs output/);
  assert.ok(workflow.indexOf("npm run build") < workflow.indexOf("wrangler versions upload"));
});

test("keeps production credentials scoped and deploys serially", () => {
  assert.match(workflow, /permissions:\n\s+contents:\s*read/);
  assert.match(workflow, /group:\s*hookemon-web-production/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /name:\s*production/);
  assert.match(workflow, /url:\s*https:\/\/hookemon\.com/);
  assert.equal((workflow.match(/secrets\.CLOUDFLARE_API_TOKEN/g) ?? []).length, 3);
  assert.equal((workflow.match(/secrets\.CLOUDFLARE_ACCOUNT_ID/g) ?? []).length, 3);
  const syncStep = workflow.slice(
    workflow.indexOf("- name: Sync public dashboard Worker bindings"),
    workflow.indexOf("- name: Upload exact CI-approved Worker version"),
  );
  const uploadStep = workflow.slice(
    workflow.indexOf("- name: Upload exact CI-approved Worker version"),
    workflow.indexOf("- name: Select uploaded Worker version"),
  );
  const promotionStep = workflow.slice(
    workflow.indexOf("- name: Deploy exact uploaded Worker version"),
    workflow.indexOf("- name: Verify structured deployment receipt"),
  );
  assert.match(
    syncStep,
    /CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/,
  );
  assert.match(
    syncStep,
    /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/,
  );
  assert.match(
    uploadStep,
    /CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/,
  );
  assert.match(
    uploadStep,
    /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/,
  );
  assert.match(
    promotionStep,
    /CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/,
  );
  assert.match(
    promotionStep,
    /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/,
  );
  assert.match(workflow, /curl[\s\S]*https:\/\/hookemon\.com\//);
});

test("synchronizes required public dashboard bindings before deployment", () => {
  const syncStart = workflow.indexOf("- name: Sync public dashboard Worker bindings");
  const deployStart = workflow.indexOf("- name: Upload exact CI-approved Worker version");
  assert.ok(syncStart >= 0);
  assert.ok(syncStart < deployStart);

  const syncStep = workflow.slice(syncStart, deployStart);
  assert.match(
    syncStep,
    /PUBLIC_DASHBOARD_PROFILE:\s*\$\{\{ secrets\.PUBLIC_DASHBOARD_PROFILE \}\}/,
  );
  assert.match(
    syncStep,
    /PUBLIC_COMMUNITY_SNAPSHOT_URL:\s*\$\{\{ secrets\.PUBLIC_COMMUNITY_SNAPSHOT_URL \}\}/,
  );
  assert.match(syncStep, /test -n "\$PUBLIC_DASHBOARD_PROFILE"/);
  assert.match(syncStep, /test -n "\$PUBLIC_COMMUNITY_SNAPSHOT_URL"/);
  assert.match(
    syncStep,
    /wrangler secret put PUBLIC_DASHBOARD_PROFILE\s+\\\s+--config dist\/server\/wrangler\.json/,
  );
  assert.match(
    syncStep,
    /wrangler secret put PUBLIC_COMMUNITY_SNAPSHOT_URL\s+\\\s+--config dist\/server\/wrangler\.json/,
  );
  assert.doesNotMatch(workflow, /hookemon-operator-control\.onrender\.com/);
});

test("accepts only the generated Hookemon production target", async () => {
  const verifier = await import("../scripts/verify-cloudflare-deploy.mjs");
  assert.equal(typeof verifier.assertGeneratedWorkerConfig, "function");
  assert.equal(typeof verifier.assertWorkerModuleExports, "function");
  const { assertGeneratedWorkerConfig } = verifier;
  assert.equal(
    assertGeneratedWorkerConfig({
      name: "hookemon-web",
      topLevelName: "hookemon-web",
      main: "index.js",
      routes: [{ pattern: "hookemon.com", custom_domain: true }],
      migrations: [
        { tag: "v1", new_sqlite_classes: ["OperatorControlDurableObject"] },
        { tag: "v2", deleted_classes: ["OperatorControlDurableObject"] },
      ],
      secrets: {
        required: [
          "OPERATOR_CONTROL_SERVICE_URL",
          "OPERATOR_CONTROL_PROXY_CREDENTIAL",
          "PUBLIC_DASHBOARD_PROFILE",
          "PUBLIC_CYCLE_STATUS_URL",
          "PUBLIC_COMMUNITY_SNAPSHOT_URL",
        ],
      },
    }),
    true,
  );
  assert.equal(
    verifier.assertWorkerModuleExports(
      "export { worker as default };",
    ),
    true,
  );
  assert.throws(
    () => assertGeneratedWorkerConfig({ name: "preview", topLevelName: "hookemon-web" }),
    /CLOUDFLARE_DEPLOY_TARGET_INVALID/,
  );
  assert.throws(
    () =>
      assertGeneratedWorkerConfig({
        name: "hookemon-web",
        topLevelName: "hookemon-web",
        main: "index.js",
        secrets: {
          required: [
            "OPERATOR_CONTROL_SERVICE_URL",
            "OPERATOR_CONTROL_PROXY_CREDENTIAL",
            "PUBLIC_DASHBOARD_PROFILE",
            "PUBLIC_CYCLE_STATUS_URL",
            "PUBLIC_COMMUNITY_SNAPSHOT_URL",
          ],
        },
      }),
    /CLOUDFLARE_DEPLOY_TARGET_INVALID/,
  );
  assert.throws(
    () => assertGeneratedWorkerConfig({ name: "hookemon-web", topLevelName: "hookemon-web" }),
    /CLOUDFLARE_DEPLOY_TARGET_INVALID/,
  );
  assert.throws(
    () =>
      assertGeneratedWorkerConfig({
        name: "hookemon-web",
        topLevelName: "hookemon-web",
        main: "index.js",
        routes: [{ pattern: "hookemon.com", custom_domain: true }],
        migrations: [
          { tag: "v1", new_sqlite_classes: ["OperatorControlDurableObject"] },
          { tag: "v2", deleted_classes: ["OperatorControlDurableObject"] },
        ],
        secrets: {
          required: [
            "OPERATOR_CONTROL_SERVICE_URL",
            "OPERATOR_CONTROL_PROXY_CREDENTIAL",
            "PUBLIC_CYCLE_STATUS_URL",
            "PUBLIC_COMMUNITY_SNAPSHOT_URL",
          ],
        },
      }),
    /CLOUDFLARE_DEPLOY_TARGET_INVALID/,
  );
  assert.throws(
    () => assertGeneratedWorkerConfig(null),
    /CLOUDFLARE_DEPLOY_TARGET_INVALID/,
  );
  assert.throws(
    () => verifier.assertWorkerModuleExports("export default worker;"),
    /CLOUDFLARE_DEPLOY_EXPORT_INVALID/,
  );
});

test("extracts the uploaded and promoted Hookemon version receipt", async () => {
  const verifier = await import("../scripts/verify-cloudflare-deploy.mjs");
  assert.equal(typeof verifier.findHookemonVersionDeployment, "function");
  const { findHookemonVersionDeployment } = verifier;
  const receipt = findHookemonVersionDeployment(
    [
      JSON.stringify({ type: "wrangler-session", timestamp: "2026-08-09T08:00:00.000Z" }),
      JSON.stringify({
        type: "version-upload",
        worker_name: "hookemon-web",
        version_id: "version-123",
        timestamp: "2026-08-09T08:00:05.000Z",
      }),
      JSON.stringify({
        type: "version-deploy",
        worker_name: "hookemon-web",
        deployment_id: "deployment-456",
        timestamp: "2026-08-09T08:00:10.000Z",
      }),
    ].join("\n"),
  );

  assert.deepEqual(receipt, {
    workerName: "hookemon-web",
    versionId: "version-123",
    versionTimestamp: "2026-08-09T08:00:05.000Z",
    deploymentId: "deployment-456",
    deploymentTimestamp: "2026-08-09T08:00:10.000Z",
  });
  assert.throws(
    () => findHookemonVersionDeployment('{"type":"command-failed"}'),
    /CLOUDFLARE_DEPLOY_RECEIPT_MISSING/,
  );
  assert.throws(
    () =>
      findHookemonVersionDeployment(
        JSON.stringify({
          type: "version-upload",
          worker_name: "hookemon-web",
          version_id: "version-123",
          timestamp: "2026-08-09T08:00:05.000Z",
        }),
      ),
    /CLOUDFLARE_DEPLOY_RECEIPT_MISSING/,
  );
  assert.throws(
    () => findHookemonVersionDeployment("not-json"),
    /CLOUDFLARE_DEPLOY_OUTPUT_INVALID/,
  );
});
