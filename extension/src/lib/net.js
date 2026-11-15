// Hosts Tor cannot reach (this machine and private networks). Requests to them
// always go direct, and never need the Tor proxy to be active.
export const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*|.*\.local)$/i;

export function isPrivateUrl(url) {
  try {
    return PRIVATE_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}
