// Telegram notification via Bot API. One aggregated digest message per poll.
// Telegram's API is api.telegram.org (not blocked by the local DNS issue), so
// we use plain fetch here. If it ever gets blocked too, swap to getJson().

import type { Bet } from "./types.js";
import { describeBet } from "./sports.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// One merged position: all of an account's fresh trades on the same market +
// outcome + side, collapsed into a single row (weighted avg price, total USD).
type Position = {
  slug: string; // market slug — drives the readable description
  outcome: string;
  side: "BUY" | "SELL";
  count: number;
  usd: number;
  // sum of price*usd, divided by usd at the end → USD-weighted average price.
  weightedPriceUsd: number;
};

// Collapse one account's bets into merged positions, keyed by market+outcome+side.
function mergePositions(bets: Bet[]): Position[] {
  const byKey = new Map<string, Position>();
  for (const b of bets) {
    const key = `${b.conditionId}|${b.outcome}|${b.side}`;
    let p = byKey.get(key);
    if (!p) {
      p = {
        slug: b.slug,
        outcome: b.outcome,
        side: b.side,
        count: 0,
        usd: 0,
        weightedPriceUsd: 0,
      };
      byKey.set(key, p);
    }
    p.count += 1;
    p.usd += b.usd;
    p.weightedPriceUsd += b.price * b.usd;
  }
  return [...byKey.values()];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Taipei time (UTC+8) as "M/D HH:MM". */
function nowTaipei(): string {
  const t = new Date(Date.now() + 8 * 3600 * 1000); // shift to UTC+8
  const M = t.getUTCMonth() + 1;
  const D = t.getUTCDate();
  const hh = String(t.getUTCHours()).padStart(2, "0");
  const mm = String(t.getUTCMinutes()).padStart(2, "0");
  return `${M}/${D} ${hh}:${mm}`;
}

/** Compact USD: 20000 → "$20k", 1200000 → "$1.2M", 850 → "$850". */
function compactUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `$${Math.round(n)}`;
}

/**
 * Build ONE aggregated digest message: one block per account that had new
 * trades. Clean layout — the account label already carries its own emoji, so
 * each block is just the label followed by its merged positions. No category
 * headers, no subtotals, no quiet-account line, no tx links.
 *
 * `betsByLabel` maps account label -> its new bets this window.
 * `allLabels` is accepted for signature compatibility but no longer rendered.
 */
export function formatDigest(
  betsByLabel: Map<string, Bet[]>,
  _allLabels: string[],
): string {
  const lines: string[] = [`📊 <b>聰明錢動態</b> · ${nowTaipei()}`];
  const sep = "━━━━━━━━━━━━━";
  lines.push(sep);

  for (const [label, bets] of betsByLabel) {
    if (bets.length === 0) continue;
    lines.push(`<b>${escapeHtml(label)}</b>`);
    for (const p of mergePositions(bets)) lines.push(`  ${formatPosition(p)}`);
  }
  return lines.join("\n");
}

// Render one merged position as a single row: action, outcome, weighted avg
// point, compact USD, and a fills count when more than one trade was collapsed.
function formatPosition(p: Position): string {
  const avgPrice = p.usd > 0 ? p.weightedPriceUsd / p.usd : 0;
  const point = (avgPrice * 100).toFixed(0);
  const action = p.side === "BUY" ? "押" : "出";
  const fills = p.count > 1 ? ` ×${p.count}` : "";
  const target = describeBet(p.slug, p.outcome); // 隊名 / 大小分 8.5 Under / 讓分 主-1.5 隊名
  return `${action} <b>${escapeHtml(target)}</b> ${point}¢ · ${compactUsd(p.usd)}${fills}`;
}

// Telegram hard limit is 4096 chars; stay safely under it.
const TG_LIMIT = 3800;

async function sendOne(text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage failed ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Send a message, auto-splitting on line boundaries if it exceeds Telegram's
 * length limit (so a long digest goes out as several messages instead of 400).
 */
export async function sendTelegram(text: string): Promise<void> {
  if (!TOKEN || !CHAT_ID) {
    console.warn("⚠ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — printing instead:\n" + text);
    return;
  }
  if (text.length <= TG_LIMIT) {
    await sendOne(text);
    return;
  }
  // split into chunks on line boundaries
  const lines = text.split("\n");
  let chunk = "";
  for (const line of lines) {
    if (chunk.length + line.length + 1 > TG_LIMIT && chunk) {
      await sendOne(chunk);
      chunk = "";
    }
    chunk = chunk ? `${chunk}\n${line}` : line;
  }
  if (chunk) await sendOne(chunk);
}
