/**
 * mlb-report.ts — daily MLB pre-game report (runs once, then exits; Windows
 * Task Scheduler calls it at 00:10 Taipei time).
 *
 * Lists today's MLB games in the Taiwan 08:00–15:00 window (the US slate you
 * wake up to) and, for each, which tracked wallets currently hold a position
 * and on which side. Pre-game snapshot only — the games haven't been played,
 * so there is NO win/loss. If no tracked wallet holds any of today's MLB
 * games, nothing is sent.
 *
 * Independent of the 15-min poll.ts line; shares only helpers.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getPositions } from "./polymarket.js";
import { getTodayMlbGames, gameKeyFromSlug, slateDateLabel } from "./mlb-schedule.js";
import { sendTelegram } from "./telegram.js";
import type { Watched } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadMlbWatchlist(): Watched[] {
  const path = join(__dirname, "..", "config", "watchlist.json");
  const { addresses } = JSON.parse(readFileSync(path, "utf8")) as { addresses: Watched[] };
  return addresses
    .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a.address))
    .filter((a) => (a.tags ?? []).includes("MLB"));
}

// Compact USD: 20000 → "$20k", 1200000 → "$1.2M", 850 → "$850". (Mirrors the
// helper in telegram.ts; kept local so this script stays self-contained.)
function compactUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `$${Math.round(n)}`;
}

// Moneyline (押哪隊獲勝) only. A game's slug has extra suffixes for other
// markets: "-total-7pt5" (over/under), "-spread-..." (run line). The moneyline
// market's slug is the bare "mlb-away-home-date", and its outcome is a team
// name (not "Over"/"Under"). Both checks together keep只勝負盤.
function isMoneyline(slug: string, outcome: string): boolean {
  const bareGame = /^mlb-[a-z]+-[a-z]+-\d{4}-\d{2}-\d{2}$/i.test(slug);
  const teamOutcome = !/^(over|under|yes|no)$/i.test(outcome.trim());
  return bareGame && teamOutcome;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// One wallet's moneyline pick on a game.
type Pick = { label: string; outcome: string; usd: number };

// Only report bets at/above this size — keeps the digest focused on real money
// and the message under Telegram's 4096-char limit as the watchlist grows.
const MIN_USD = 3000;

async function main() {
  const watchlist = loadMlbWatchlist();
  const games = await getTodayMlbGames();

  if (games.length === 0) {
    console.log("無今日 MLB 賽事,本次不推送。");
    return;
  }

  const validKeys = new Set(games.map((g) => g.gameKey));
  // gameKey -> moneyline picks by tracked wallets currently holding that game
  const picksByGame = new Map<string, Pick[]>();

  for (const w of watchlist) {
    let positions;
    try {
      positions = await getPositions(w.address);
    } catch (e) {
      console.error(`✗ ${w.label} positions fetch failed: ${(e as Error).message}`);
      continue;
    }
    for (const p of positions) {
      if (p.redeemable || p.currentValue <= 0) continue; // active only
      if (p.currentValue < MIN_USD) continue; // skip small bets (keeps msg short)
      const key = gameKeyFromSlug(p.slug);
      if (!key || !validKeys.has(key)) continue; // one of today's games
      if (!isMoneyline(p.slug, p.outcome)) continue; // 勝負盤 only (skip O/U, spread)
      const list = picksByGame.get(key) ?? [];
      if (list.some((x) => x.label === w.label && x.outcome === p.outcome)) continue; // dedup
      list.push({ label: w.label, outcome: p.outcome, usd: p.currentValue });
      picksByGame.set(key, list);
    }
  }

  const totalPicks = [...picksByGame.values()].reduce((n, l) => n + l.length, 0);
  if (totalPicks === 0) {
    console.log("今日 MLB 賽事無任何聰明錢進場,本次不推送。");
    return;
  }

  // build message — list ALL of today's games; games with no bets show "尚無".
  // Within a game, GROUP picks by the team they backed, so you see at a glance
  // how the money splits between the two sides.
  const lines: string[] = [`⚾ <b>今日 MLB</b> · ${slateDateLabel(games)} · ${games.length} 場`];
  lines.push("━━━━━━━━━━━━━");
  const PER_TEAM_CAP = 8; // names listed per team side before folding
  for (const g of games) {
    lines.push(`<b>${g.away} vs ${g.home}</b>`);
    const picks = picksByGame.get(g.gameKey) ?? [];
    if (picks.length === 0) {
      lines.push("  尚無聰明錢進場");
      continue;
    }
    // group by backed team (outcome)
    const byTeam = new Map<string, Pick[]>();
    for (const p of picks) (byTeam.get(p.outcome) ?? byTeam.set(p.outcome, []).get(p.outcome)!).push(p);

    // team groups ordered by total money on that side (heavier side first)
    const groups = [...byTeam.entries()]
      .map(([team, ps]) => ({
        team,
        ps: ps.sort((a, b) => b.usd - a.usd),
        total: ps.reduce((n, p) => n + p.usd, 0),
      }))
      .sort((a, b) => b.total - a.total);

    for (const grp of groups) {
      lines.push(
        `  ▸ <b>${escapeHtml(grp.team)}</b> (${grp.ps.length}人 ${compactUsd(grp.total)})`,
      );
      const shown = grp.ps.slice(0, PER_TEAM_CAP);
      const names = shown.map((p) => `${escapeHtml(p.label)} ${compactUsd(p.usd)}`).join(" · ");
      lines.push(`     ${names}`);
      if (grp.ps.length > PER_TEAM_CAP) {
        lines.push(`     <i>…還有 ${grp.ps.length - PER_TEAM_CAP} 人</i>`);
      }
    }
  }
  const msg = lines.join("\n");

  try {
    await sendTelegram(msg);
    console.log(`done. MLB 賽前報告已推送(今日 ${games.length} 場,${totalPicks} 筆聰明錢下注)。`);
  } catch (e) {
    console.error(`✗ 推送失敗: ${(e as Error).message}`);
  }
}

main().catch((e) => {
  console.error("✗ mlb-report failed:", e);
  process.exit(1);
});
