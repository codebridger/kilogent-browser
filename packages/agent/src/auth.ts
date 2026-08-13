// The bearer the bridge's MCP face requires.
//
// This file exists because it did not. The MCP face used to be unauthenticated — loopback was the
// whole security model — and when that changed, `packages/bridge-server` grew `requireBearer` while
// this package was not touched. Every connection here has 401'd since, including `npm run smoke`,
// which the README offered as the way to verify an install. The failure is invisible from the
// server side (a 401 is a correct response) and this package is in no CI lane, so nothing said so.
//
// Absent token = no header, deliberately: a bridge running without BRIDGE_MCP_TOKEN refuses to
// start at all, so the only reader who gets here is someone pointed at something else entirely,
// and a fabricated `Bearer undefined` would be a worse error message than none.
export function mcpAuth(): { requestInit?: { headers: Record<string, string> } } {
  const token = process.env.BRIDGE_MCP_TOKEN ?? "";
  if (!token) return {};
  return { requestInit: { headers: { Authorization: `Bearer ${token}` } } };
}
