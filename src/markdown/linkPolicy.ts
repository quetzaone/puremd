const allowedProtocols = new Set(["http:", "https:"]);

/**
 * The whole link policy, and it needs no companion listing the dangerous
 * schemes: `javascript:`, `data:`, `file:` and `vbscript:` cannot parse into an
 * allowed protocol, so they are already refused here.
 */
export function isAllowedWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return allowedProtocols.has(url.protocol);
  } catch {
    return false;
  }
}
