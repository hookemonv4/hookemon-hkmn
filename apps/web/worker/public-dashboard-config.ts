import { readDashboardProfile } from "../lib/public-dashboard-profile.ts";

export type PublicDashboardEnvironment = {
  PUBLIC_DASHBOARD_PROFILE?: string;
  PUBLIC_CYCLE_STATUS_URL?: string;
  PUBLIC_COMMUNITY_SNAPSHOT_URL?: string;
};

export function readPublicDashboardConfig(env: PublicDashboardEnvironment) {
  const profile = readDashboardProfile(env.PUBLIC_DASHBOARD_PROFILE).id;
  const cycleStatusUrl = exactPublicUrl(
    env.PUBLIC_CYCLE_STATUS_URL,
    "/public/api/cycle-status",
  );
  const communitySnapshotUrl = exactPublicUrl(
    env.PUBLIC_COMMUNITY_SNAPSHOT_URL,
    "/public/api/community-dashboard",
  );
  if (cycleStatusUrl.origin !== communitySnapshotUrl.origin) {
    throw new TypeError("PUBLIC_DASHBOARD_UPSTREAM_MISMATCH");
  }
  return { profile, cycleStatusUrl, communitySnapshotUrl };
}

function exactPublicUrl(value: string | undefined, expectedPath: string): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new TypeError("PUBLIC_DASHBOARD_URL_INVALID");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("PUBLIC_DASHBOARD_URL_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.pathname !== expectedPath ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    value !== `https://${url.hostname}${expectedPath}`
  ) {
    throw new TypeError("PUBLIC_DASHBOARD_URL_INVALID");
  }
  return url;
}
