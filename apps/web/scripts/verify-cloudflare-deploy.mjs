import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WORKER_NAME = "hookemon-web";
const RETIRED_OPERATOR_CLASS = "OperatorControlDurableObject";
const REQUIRED_WORKER_SECRETS = [
  "OPERATOR_CONTROL_SERVICE_URL",
  "OPERATOR_CONTROL_PROXY_CREDENTIAL",
  "PUBLIC_DASHBOARD_PROFILE",
  "PUBLIC_CYCLE_STATUS_URL",
  "PUBLIC_COMMUNITY_SNAPSHOT_URL",
];

export function assertGeneratedWorkerConfig(config) {
  const requiredSecrets = config?.secrets?.required;
  const routes = config?.routes;
  const migrations = config?.migrations;
  if (
    !config ||
    typeof config !== "object" ||
    config.name !== WORKER_NAME ||
    config.topLevelName !== WORKER_NAME ||
    typeof config.main !== "string" ||
    config.main.length === 0 ||
    !Array.isArray(routes) ||
    !routes.some(
      (route) => route?.pattern === "hookemon.com" && route.custom_domain === true,
    ) ||
    !Array.isArray(migrations) ||
    migrations.length !== 2 ||
    migrations[0]?.tag !== "v1" ||
    !migrations[0]?.new_sqlite_classes?.includes(RETIRED_OPERATOR_CLASS) ||
    migrations[1]?.tag !== "v2" ||
    !migrations[1]?.deleted_classes?.includes(RETIRED_OPERATOR_CLASS) ||
    !Array.isArray(requiredSecrets) ||
    !REQUIRED_WORKER_SECRETS.every((secret) => requiredSecrets.includes(secret))
  ) {
    throw new Error("CLOUDFLARE_DEPLOY_TARGET_INVALID");
  }

  return true;
}

export function assertWorkerModuleExports(source) {
  if (
    typeof source !== "string" ||
    !/\bexport\s*\{[^}]*\bas default\b[^}]*\}/s.test(source)
  ) {
    throw new Error("CLOUDFLARE_DEPLOY_EXPORT_INVALID");
  }

  return true;
}

function parseWranglerOutput(ndjson) {
  let entries;
  try {
    entries = ndjson
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    throw new Error("CLOUDFLARE_DEPLOY_OUTPUT_INVALID");
  }

  return entries;
}

function isSafeIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9-]+$/.test(value);
}

export function findHookemonVersionUpload(ndjson) {
  const entries = parseWranglerOutput(ndjson);
  const upload = entries.findLast(
    (entry) =>
      entry?.type === "version-upload" &&
      entry.worker_name === WORKER_NAME &&
      isSafeIdentifier(entry.version_id) &&
      typeof entry.timestamp === "string" &&
      entry.timestamp.length > 0,
  );

  if (!upload) throw new Error("CLOUDFLARE_DEPLOY_RECEIPT_MISSING");

  return {
    workerName: upload.worker_name,
    versionId: upload.version_id,
    timestamp: upload.timestamp,
  };
}

export function findHookemonVersionDeployment(ndjson) {
  const entries = parseWranglerOutput(ndjson);
  let uploadIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === "version-upload" &&
      entry.worker_name === WORKER_NAME &&
      isSafeIdentifier(entry.version_id) &&
      typeof entry.timestamp === "string" &&
      entry.timestamp.length > 0
    ) {
      uploadIndex = index;
      break;
    }
  }

  const deployment = entries.find(
    (entry, index) =>
      index > uploadIndex &&
      entry?.type === "version-deploy" &&
      entry.worker_name === WORKER_NAME &&
      isSafeIdentifier(entry.deployment_id) &&
      typeof entry.timestamp === "string" &&
      entry.timestamp.length > 0,
  );

  if (uploadIndex < 0 || !deployment) {
    throw new Error("CLOUDFLARE_DEPLOY_RECEIPT_MISSING");
  }

  const upload = entries[uploadIndex];

  return {
    workerName: upload.worker_name,
    versionId: upload.version_id,
    versionTimestamp: upload.timestamp,
    deploymentId: deployment.deployment_id,
    deploymentTimestamp: deployment.timestamp,
  };
}

function runCli([mode, filePath]) {
  if (!filePath || !["config", "version-id", "output"].includes(mode)) {
    throw new Error("CLOUDFLARE_DEPLOY_VERIFY_USAGE_INVALID");
  }

  const contents = readFileSync(filePath, "utf8");
  if (mode === "config") {
    const config = JSON.parse(contents);
    assertGeneratedWorkerConfig(config);
    assertWorkerModuleExports(readFileSync(resolve(dirname(filePath), config.main), "utf8"));
    process.stdout.write(`Worker target verified: ${WORKER_NAME}\n`);
    return;
  }

  if (mode === "version-id") {
    const upload = findHookemonVersionUpload(contents);
    process.stdout.write(`version_id=${upload.versionId}\n`);
    return;
  }

  const receipt = findHookemonVersionDeployment(contents);
  process.stdout.write(
    `### Cloudflare deployment\n\n- Worker: \`${receipt.workerName}\`\n- Version: \`${receipt.versionId}\`\n- Version uploaded: \`${receipt.versionTimestamp}\`\n- Deployment: \`${receipt.deploymentId}\`\n- Deployed: \`${receipt.deploymentTimestamp}\`\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2));
}
