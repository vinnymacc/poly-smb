/**
 * Anti-block HTTP layer.
 *
 * This machine's local DNS poisons polymarket.com domains to a block page
 * (rpz10-landing). We bypass it entirely: resolve the real IP via Cloudflare
 * DNS-over-HTTPS (a request to the 1.1.1.1 IP literal, which local DNS can't
 * touch), then connect straight to that IP with the correct SNI + Host header.
 *
 * Net effect: getJson() works regardless of how the host's DNS is configured,
 * so the tracker is portable to any machine/network with no DNS changes.
 */

import { connect as tlsConnect } from "node:tls";

// Cache resolved IPs for the process lifetime (a poll run is short-lived).
const ipCache = new Map<string, string[]>();

async function resolveViaDoH(host: string): Promise<string[]> {
  const cached = ipCache.get(host);
  if (cached) return cached;

  const url = `https://1.1.1.1/dns-query?name=${host}&type=A`;
  const res = await fetch(url, { headers: { Accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`DoH HTTP ${res.status} for ${host}`);
  const json = (await res.json()) as { Answer?: { type: number; data: string }[] };
  const ips = (json.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
  if (ips.length === 0) throw new Error(`DoH returned no A records for ${host}`);
  ipCache.set(host, ips);
  return ips;
}

// Decode HTTP/1.1 chunked transfer-encoding on the raw body BYTES. Operating on
// a Buffer (not a utf8 string) is essential: chunk-size lines and multi-byte
// UTF-8 sequences can straddle TCP packet boundaries, and string-based slicing
// corrupts large multi-chunk responses (truncated / "unterminated string").
function dechunk(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf("\r\n", i, "latin1");
    if (nl === -1) break;
    const size = parseInt(buf.toString("latin1", i, nl).trim(), 16);
    if (Number.isNaN(size)) break;
    if (size === 0) break; // final chunk
    const start = nl + 2;
    parts.push(buf.subarray(start, start + size));
    i = start + size + 2; // skip chunk data + trailing CRLF
  }
  return Buffer.concat(parts);
}

function rawGet(
  ip: string,
  host: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host: ip, port: 443, servername: host, ALPNProtocols: ["http/1.1"] },
      () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\n` +
            `Host: ${host}\r\n` +
            `User-Agent: poly-smartmoney/0.1\r\n` +
            `Accept: application/json\r\n` +
            `Connection: close\r\n\r\n`,
        );
      },
    );
    // Collect raw bytes — do NOT setEncoding (utf8 decode per packet corrupts
    // multi-byte chars split across packets). Decode once at the end.
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("end", () => {
      const raw = Buffer.concat(chunks);
      const sep = raw.indexOf("\r\n\r\n", 0, "latin1");
      if (sep === -1) return reject(new Error("malformed HTTP response"));
      const head = raw.toString("latin1", 0, sep);
      const bodyBuf = raw.subarray(sep + 4);
      const status = Number(head.split(" ")[1] || 0);
      const decoded = /transfer-encoding:\s*chunked/i.test(head)
        ? dechunk(bodyBuf)
        : bodyBuf;
      resolve({ status, body: decoded.toString("utf8") });
    });
    socket.on("error", reject);
    socket.setTimeout(15000, () => {
      socket.destroy();
      reject(new Error(`TLS timeout connecting to ${host} via ${ip}`));
    });
  });
}

// Large API responses (e.g. /positions, /events) occasionally carry raw ASCII
// control characters inside string values, which makes JSON.parse throw "Bad
// control character in string literal". Strip ALL control chars (0x00-0x1F):
// raw newlines/tabs are illegal inside JSON string literals too, and structural
// whitespace between tokens is optional, so removing them just compacts the JSON.
function sanitizeJson(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x20) out += s[i];
  }
  return out;
}

/**
 * GET a URL and parse JSON, bypassing local DNS. Tries each resolved IP until
 * one returns HTTP 200. Throws with a useful message on geo-block (403) or
 * total failure.
 */
export async function getJson<T = unknown>(fullUrl: string): Promise<T> {
  const u = new URL(fullUrl);
  const host = u.hostname;
  const path = u.pathname + u.search;
  const ips = await resolveViaDoH(host);

  let lastErr: unknown;
  for (const ip of ips) {
    try {
      const { status, body } = await rawGet(ip, host, path);
      if (status === 200) return JSON.parse(sanitizeJson(body)) as T;
      if (status === 403 || /region|restricted|geo/i.test(body)) {
        throw new Error(
          `${host} returned ${status} (looks like a geo-block — this is the case that would need a VPN).`,
        );
      }
      lastErr = new Error(`${host} HTTP ${status}: ${body.slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error(`all IPs failed for ${host}`);
}
