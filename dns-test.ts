/**
 * DNS bypass test — does NOT change any system setting.
 *
 * Your local DNS resolves data-api.polymarket.com to a block page
 * (182.173.0.181, CN=rpz10-landing). This script:
 *   1. Asks Cloudflare DNS-over-HTTPS (https://1.1.1.1/dns-query) for the
 *      REAL IP, bypassing your poisoned local resolver.
 *   2. Connects straight to that real IP and calls the Polymarket API,
 *      sending the correct SNI/Host header so TLS + routing still work.
 *
 * If this succeeds, the block is 100% local DNS (no VPN needed) and we just
 * need to point this machine at a clean resolver. If it fails with a 403 /
 * region error, THEN it's an IP geo-block and a VPN is the answer.
 */

import { connect as tlsConnect } from "node:tls";

const HOST = "data-api.polymarket.com";
const PATH =
  "/activity?user=0x9d84ce0306f8551e02efef1680475fc0f1dc1344&type=TRADE&limit=3&sortBy=TIMESTAMP";

// 1) Resolve the real IP via Cloudflare DoH (this request goes to 1.1.1.1
//    over HTTPS, which your local DNS can't poison).
async function resolveViaDoH(host: string): Promise<string[]> {
  const url = `https://1.1.1.1/dns-query?name=${host}&type=A`;
  const res = await fetch(url, { headers: { Accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
  const json = (await res.json()) as { Answer?: { type: number; data: string }[] };
  const ips = (json.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
  if (ips.length === 0) throw new Error("DoH returned no A records");
  return ips;
}

// Decode HTTP/1.1 chunked transfer encoding into the plain body.
function dechunk(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const nl = s.indexOf("\r\n", i);
    if (nl === -1) break;
    const size = parseInt(s.slice(i, nl).trim(), 16);
    if (!size || Number.isNaN(size)) break;
    out += s.slice(nl + 2, nl + 2 + size);
    i = nl + 2 + size + 2; // skip chunk data + trailing CRLF
  }
  return out;
}

// 2) Raw HTTPS GET to a specific IP, with correct SNI + Host header.
function httpsGetViaIp(ip: string, host: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host: ip, port: 443, servername: host, ALPNProtocols: ["http/1.1"] },
      () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: poly-smartmoney-dnstest/0.1\r\nAccept: application/json\r\nConnection: close\r\n\r\n`,
        );
      },
    );
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (c) => (raw += c));
    socket.on("end", () => {
      const sep = raw.indexOf("\r\n\r\n");
      const head = raw.slice(0, sep);
      let bodyRaw = raw.slice(sep + 4);
      const status = Number(head.split(" ")[1] || 0);
      // Decode HTTP/1.1 chunked transfer encoding if present.
      const body = /transfer-encoding:\s*chunked/i.test(head)
        ? dechunk(bodyRaw)
        : bodyRaw;
      resolve({ status, body });
    });
    socket.on("error", reject);
    socket.setTimeout(15000, () => {
      socket.destroy();
      reject(new Error("TLS timeout"));
    });
  });
}

async function main() {
  console.log(`\n→ Resolving ${HOST} via Cloudflare DoH (bypassing local DNS)...`);
  const ips = await resolveViaDoH(HOST);
  console.log(`  real IP(s): ${ips.join(", ")}`);

  for (const ip of ips) {
    console.log(`\n→ Connecting directly to ${ip} and calling the API...`);
    try {
      const { status, body } = await httpsGetViaIp(ip, HOST, PATH);
      console.log(`  HTTP ${status}`);
      if (status === 200) {
        const data = JSON.parse(body);
        console.log(`  ✓ SUCCESS — got ${Array.isArray(data) ? data.length : "?"} items.`);
        console.log("  First item (trimmed):");
        console.log(JSON.stringify(Array.isArray(data) ? data[0] : data, null, 2).slice(0, 900));
        console.log(
          "\n結論: 封鎖純粹是本機 DNS 問題，不需要 VPN。把 DNS 改成 1.1.1.1 即可正常用真實 API。",
        );
        return;
      } else if (status === 403 || /region|restricted|forbidden/i.test(body)) {
        console.log("  ⚠ 連得到伺服器，但被拒絕（看起來像地區限制）。");
        console.log("  結論: 這種情況才需要 VPN（翻到沒被鎖的國家）。");
        console.log(body.slice(0, 400));
        return;
      } else {
        console.log("  unexpected:", body.slice(0, 400));
      }
    } catch (e) {
      console.log(`  ✗ ${ip} failed:`, (e as Error).message);
    }
  }
}

main().catch((e) => {
  console.error("✗ DNS test failed:", e);
  process.exit(1);
});
