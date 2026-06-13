/**
 * SPIKE — prove the Polymarket Data API actually returns the fields we need
 * before building anything on top of it.
 *
 * Hits the public /activity endpoint for one address and prints the raw shape
 * + a normalized view of the six fields we care about:
 *   誰 / 何時 / 哪個市場 / 哪一邊 / 點位(price) / 金額(usdcSize)
 *
 * Run: npm run spike            (uses a known public address)
 *      npm run spike 0xYourAddr (test one of your own watchlist addresses)
 */

const DATA_API = "https://data-api.polymarket.com";

// A known active public Polymarket trader address, used only to prove the API
// works before the real watchlist exists. Override by passing an address arg.
const DEFAULT_ADDR = "0x9d84ce0306f8551e02efef1680475fc0f1dc1344";

async function main() {
  const addr = (process.argv[2] || DEFAULT_ADDR).toLowerCase();
  const url = `${DATA_API}/activity?user=${addr}&type=TRADE&limit=5&sortBy=TIMESTAMP`;

  console.log(`\n→ GET ${url}\n`);

  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "poly-smartmoney-spike/0.1" },
  });

  if (!res.ok) {
    console.error(`✗ HTTP ${res.status} ${res.statusText}`);
    const body = await res.text();
    console.error(body.slice(0, 500));
    process.exit(1);
  }

  const data = (await res.json()) as any[];

  if (!Array.isArray(data) || data.length === 0) {
    console.log("⚠ No TRADE activity returned for this address (it may be inactive).");
    console.log("Raw response:", JSON.stringify(data, null, 2).slice(0, 800));
    return;
  }

  console.log(`✓ Got ${data.length} trade activities.\n`);
  console.log("── RAW first item (all fields the API gives us) ──");
  console.log(JSON.stringify(data[0], null, 2));

  console.log("\n── NORMALIZED view of the 6 fields you asked for ──");
  for (const a of data) {
    const when = new Date(Number(a.timestamp) * 1000).toISOString().replace("T", " ").slice(0, 16);
    const usd = a.usdcSize ?? a.size * a.price;
    console.log(
      [
        `誰     : ${a.name || a.pseudonym || a.proxyWallet}`,
        `何時   : ${when} UTC`,
        `市場   : ${a.title}`,
        `哪一邊 : ${a.outcome} (BUY/SELL=${a.side})`,
        `點位   : ${a.price}`,
        `金額   : $${Number(usd).toFixed(2)}`,
        `conditionId: ${a.conditionId}`,
        `tx     : https://polygonscan.com/tx/${a.transactionHash}`,
      ].join("\n  ") + "\n",
    );
  }

  // Report which of the six target fields are actually present — the whole
  // point of the spike. If any is undefined, we adjust the plan before coding.
  const f = data[0];
  const checks: [string, boolean][] = [
    ["誰 (proxyWallet)", f.proxyWallet != null],
    ["何時 (timestamp)", f.timestamp != null],
    ["市場 (title/conditionId)", f.title != null && f.conditionId != null],
    ["哪一邊 (outcome/side)", f.outcome != null && f.side != null],
    ["點位 (price)", f.price != null],
    ["金額 (usdcSize/size)", f.usdcSize != null || f.size != null],
  ];
  console.log("── FIELD AVAILABILITY ──");
  for (const [label, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${label}`);
}

main().catch((e) => {
  console.error("✗ Spike failed:", e);
  process.exit(1);
});
