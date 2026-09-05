import vinext from "vinext";
import { defineConfig } from "vite";

const requiredWorkerSecrets = [
  "OPERATOR_CONTROL_SERVICE_URL",
  "OPERATOR_CONTROL_PROXY_CREDENTIAL",
  "PUBLIC_DASHBOARD_PROFILE",
  "PUBLIC_CYCLE_STATUS_URL",
  "PUBLIC_COMMUNITY_SNAPSHOT_URL",
];

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_date: "2026-08-07",
  compatibility_flags: ["nodejs_compat"],
  assets: { binding: "ASSETS", run_worker_first: true },
  routes: [{ pattern: "hookemon.com", custom_domain: true }],
  migrations: [
    {
      tag: "v1",
      new_sqlite_classes: ["OperatorControlDurableObject"],
    },
    {
      tag: "v2",
      deleted_classes: ["OperatorControlDurableObject"],
    },
  ],
  secrets: {
    required: requiredWorkerSecrets,
  },
  d1_databases: [],
  r2_buckets: [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    resolve: {
      dedupe: ["jose"],
    },
    plugins: [
      vinext(),
      cloudflare({
        inspectorPort: false,
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
