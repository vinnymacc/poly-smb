// One-off / on-demand discovery: find the biggest MLB moneyline bettors that
// aren't already in the watchlist, ranked by total MLB position size.
//
// How: list upcoming MLB games (Gamma), keep ONLY the bare moneyline market
// (slug "mlb-away-home-date", no -nrfi/-spread/-total suffix), then for each
// call /holders and sum each wallet's `amount` across all MLB games.
//
// Run:  npx tsx src/discover-mlb-whales.mts          (preview top 50, no write)
//       npx tsx src/discover-mlb-whales.mts --write   (also append to watchlist)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getJson } from "./http.js";

const GAMMA = process.env.POLY_GAMMA_API || "https://gamma-api.polymarket.com";
const DATA = process.env.POLY_DATA_API || "https://data-api.polymarket.com";
const __dirname = dirname(fileURLToPath(import.meta.url));
// Preview shows top 50; --write appends the top N_WRITE.
const TOP_N = 50;
const N_WRITE = 30;
const WRITE = process.argv.includes("--write");

// Animal-name pool: two-CJK-char names with a leading emoji, harvested from
// config/animals.md, minus any already used in the watchlist.
function availableAnimals(mdText: string, usedNames: Set<string>): string[] {
  const matches = mdText.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}][一-鿿]{2}/gu) || [];
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const m of matches) {
    const bare = m.replace(/[^一-鿿]/g, "");
    if (seen.has(bare)) continue;
    seen.add(bare);
    if (!usedNames.has(bare)) pool.push(m); // keep emoji+name
  }
  return pool;
}

// Strict moneyline: bare game slug, no suffix.
const MONEYLINE = /^mlb-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}$/i;

type Holder = { proxyWallet: string; pseudonym?: string; name?: string; amount: number };
type HolderGroup = { token: string; holders: Holder[] };

async function listMlbMoneylineConds(): Promise<string[]> {
  const conds = new Set<string>();
  // paginate through baseball events
  for (let offset = 0; offset < 300; offset += 100) {
    let ev: any[] = [];
    try {
      ev = (await getJson<any[]>(
        `${GAMMA}/events?closed=false&limit=100&offset=${offset}&order=startDate&ascending=true&tag_slug=baseball`,
      )) as any[];
    } catch {
      break;
    }
    if (!Array.isArray(ev) || ev.length === 0) break;
    for (const e of ev) {
      for (const m of e.markets || []) {
        if (MONEYLINE.test(m.slug || "") && m.conditionId) conds.add(m.conditionId);
      }
    }
    if (ev.length < 100) break;
  }
  return [...conds];
}

async function main() {
  // load existing watchlist addresses to exclude
  const wlPath = join(__dirname, "..", "config", "watchlist.json");
  const wl = JSON.parse(readFileSync(wlPath, "utf8")) as {
    addresses: { address: string; label: string; tags?: string[] }[];
  };
  const existing = new Set(wl.addresses.map((a) => a.address.toLowerCase()));

  const conds = await listMlbMoneylineConds();
  console.log(`MLB moneyline markets: ${conds.length}`);

  // sum each wallet's amount across all MLB moneyline markets
  const totals = new Map<string, { usd: number; name: string }>();
  let done = 0;
  for (const cond of conds) {
    try {
      const groups = (await getJson<HolderGroup[]>(`${DATA}/holders?market=${cond}`)) as HolderGroup[];
      for (const g of groups || []) {
        for (const h of g.holders || []) {
          const w = h.proxyWallet?.toLowerCase();
          if (!w) continue;
          const prev = totals.get(w) ?? { usd: 0, name: h.pseudonym || h.name || "" };
          prev.usd += h.amount || 0;
          totals.set(w, prev);
        }
      }
    } catch {
      /* skip a market that fails */
    }
    if (++done % 10 === 0) console.log(`  scanned ${done}/${conds.length} markets…`);
  }

  // rank, exclude existing, take top N
  const ranked = [...totals.entries()]
    .filter(([w]) => !existing.has(w))
    .map(([w, v]) => ({ wallet: w, usd: Math.round(v.usd), name: v.name }))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, TOP_N);

  console.log(`\n=== Top ${ranked.length} MLB whales NOT in watchlist (by total MLB position $) ===`);
  ranked.forEach((r, i) =>
    console.log(`${String(i + 1).padStart(2)}. ${r.wallet}  $${r.usd.toLocaleString()}  ${r.name}`),
  );

  if (!WRITE) {
    console.log(`\n(預覽模式。確認後加 --write 才會寫進前 ${N_WRITE} 名到 watchlist。)`);
    return;
  }

  // --write: take top N_WRITE, assign animal names, append, mark animals.md.
  const pick = ranked.slice(0, N_WRITE);
  const usedNames = new Set(wl.addresses.map((a) => a.label.replace(/[^一-鿿]/g, "")));
  const mdPath = join(__dirname, "..", "config", "animals.md");
  const mdText = readFileSync(mdPath, "utf8");
  const animals = availableAnimals(mdText, usedNames);
  if (animals.length < pick.length) {
    console.error(`✗ 動物名不夠:需要 ${pick.length},可用 ${animals.length}。請先補 animals.md。`);
    return;
  }

  const newlyUsed: string[] = [];
  for (let i = 0; i < pick.length; i++) {
    const animal = animals[i];
    newlyUsed.push(animal);
    wl.addresses.push({ address: pick[i].wallet, label: animal, tags: ["MLB"] });
  }
  writeFileSync(wlPath, JSON.stringify(wl, null, 2) + "\n", "utf8");
  console.log(`\n✓ 已寫進 ${pick.length} 個地址到 watchlist (現共 ${wl.addresses.length} 個)`);

  // mark the used animals in animals.md by appending to the "已使用" line
  const updated = mdText.replace(
    /(## 已使用[^\n]*\n\n)([^\n]*)/,
    (_m, head, line) => `${head}${line} · ${newlyUsed.join(" · ")}`,
  );
  writeFileSync(mdPath, updated, "utf8");
  console.log(`✓ animals.md 已標記 ${newlyUsed.length} 個新用掉的動物`);
  console.log(`  配對:${pick.map((p, i) => `${newlyUsed[i]}=${p.wallet.slice(0, 8)}…`).join(" ")}`);
}

main().catch((e) => console.error("ERR", e.message));
