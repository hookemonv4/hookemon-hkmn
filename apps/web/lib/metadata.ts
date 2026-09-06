function normalizedHostname(host: string): string {
  const hostname = new URL(`http://${host.trim()}`).hostname.toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function resolveMetadataBase(host: string, forwardedProtocol?: string | null): URL {
  const hostname = normalizedHostname(host);
  const isLoopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  const requestedProtocol = forwardedProtocol?.split(",", 1)[0]?.trim().toLowerCase();
  const protocol = isLoopback ? "http" : requestedProtocol === "http" ? "http" : "https";

  return new URL(`${protocol}://${host}`);
}
