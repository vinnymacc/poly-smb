/**
 * poll.ts — the tracker. Runs once, then exits (Windows Task Scheduler calls
 * it every 15 min). For each watched address:
 *   1. fetch recent trades from Polymarket
 *   2. drop anything we've already seen (dedup)
 *   3. on an address's first-ever run, record as baseline WITHOUT notifying
 *   4. classify each new trade into a sport, record to DB (history)
 * Then ONE aggregated digest message is sent per run: a block per account
 * that had new trades, plus a line for the quiet ones.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getActivity } from "./polymarket.js";
import { classify, reportKind } from "./sports.js";
import { formatDigest, sendTelegram } from "./telegram.js";
import { isBaselined, markBaselined, markSeenOnly, recordBet, seen } from "./db.js";
import type { Bet, RawActivity, Watched } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadWatchlist(): Watched[] {
  const path = join(__dirname, "..", "config", "watchlist.json");
  const { addresses } = JSON.parse(readFileSync(path, "utf8")) as { addresses: Watched[] };
  return addresses.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a.address));
}

async function toBet(a: RawActivity, label: string): Promise<Bet> {
  const { category, sport } = await classify(a.conditionId, a.title);
  return {
    wallet: a.proxyWallet,
    label,
    sport,
    category,
    market: a.title,
    slug: a.slug,
    outcome: a.outcome,
    side: a.side,
    price: a.price,
    usd: a.usdcSize ?? a.size * a.price,
    timestamp: a.timestamp,
    conditionId: a.conditionId,
    txHash: a.transactionHash,
    txUrl: `https://polygonscan.com/tx/${a.transactionHash}`,
  };
}

// Collect this run's notify-worthy new bets for one address (does NOT send).
// Returns the bets that should appear in the digest; records all fresh trades
// to the DB regardless.
async function collectNewBets(w: Watched): Promise<Bet[]> {
  let activities: RawActivity[];
  try {
    activities = await getActivity(w.address);
  } catch (e) {
    console.error(`✗ ${w.label} (${w.address}) fetch failed: ${(e as Error).message}`);
    return [];
  }

  // Cold start: first time we ever see this address — baseline silently.
  if (!isBaselined(w.address)) {
    for (const a of activities) markSeenOnly(a.transactionHash, a.timestamp);
    markBaselined(w.address, Math.floor(Date.now() / 1000));
    console.log(`• ${w.label}: baselined ${activities.length} existing trades (no notify).`);
    return [];
  }

  // New = not seen before. API returns newest first; present oldest first.
  const fresh = activities.filter((a) => !seen(a.transactionHash)).reverse();

  // Catch-up cap: after the PC was off, anything older than NOTIFY_MAX_AGE_MIN
  // is recorded silently (in DB, not in the digest) so a backlog doesn't flood
  // you. Trades made while we poll normally are only minutes old, so included.
  const maxAgeMin = Number(process.env.NOTIFY_MAX_AGE_MIN ?? "60");
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeMin * 60;

  const toNotify: Bet[] = [];
  let skippedOld = 0;
  let skippedKind = 0;
  for (const a of fresh) {
    const bet = await toBet(a, w.label);
    recordBet(bet); // always record to DB (full history), even if not notified
    // Only notify on MLB single games and World Cup single games. Futures
    // ("Will X win the World Cup?") and other sports are recorded, not pushed.
    if (reportKind(a.slug, a.title) === null) {
      skippedKind++;
      continue;
    }
    if (a.timestamp < cutoff) skippedOld++;
    else toNotify.push(bet);
  }
  if (fresh.length) {
    const parts: string[] = [];
    if (skippedKind) parts.push(`${skippedKind} 筆非 MLB/WC 單場`);
    if (skippedOld) parts.push(`${skippedOld} 筆超過 ${maxAgeMin} 分鐘`);
    const tail = parts.length ? ` (略過 ${parts.join("、")})` : "";
    console.log(`• ${w.label}: ${fresh.length} 筆新 → 入彙整 ${toNotify.length}${tail}.`);
  } else {
    console.log(`• ${w.label}: 無新動作.`);
  }
  return toNotify;
}

async function main() {
  const watchlist = loadWatchlist();
  if (watchlist.length === 0) {
    console.error("✗ No valid addresses in config/watchlist.json. Add real 0x addresses.");
    process.exit(1);
  }
  console.log(`\n[${new Date().toISOString()}] polling ${watchlist.length} address(es)...`);

  // Collect per account (preserves watchlist order in the digest).
  const betsByLabel = new Map<string, Bet[]>();
  for (const w of watchlist) betsByLabel.set(w.label, await collectNewBets(w));

  const totalNew = [...betsByLabel.values()].reduce((n, b) => n + b.length, 0);

  // Only send a digest when there's something to report — no "all quiet" spam.
  if (totalNew > 0) {
    const labels = watchlist.map((w) => w.label);
    try {
      await sendTelegram(formatDigest(betsByLabel, labels));
      console.log(`done. 彙整已推送（${totalNew} 筆新動作）。\n`);
    } catch (e) {
      console.error(`✗ 彙整推送失敗: ${(e as Error).message}`);
    }
  } else {
    console.log("done. 無新動作，本次不推送。\n");
  }
}

main().catch((e) => {
  console.error("✗ poll failed:", e);
  process.exit(1);
});
