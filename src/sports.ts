// Classify a Polymarket market into a sport.
//
// Primary signal: the market's slug/title from Gamma, matched against sport
// keywords. This is fast, needs no tag-id bookkeeping, and is reliable for the
// three sports we care about (MLB / NBA / soccer). Polymarket sports markets
// have descriptive slugs like "mlb-nyy-bos-2026-06-04".
//
// We look the market up by conditionId via Gamma once and cache it, so repeated
// activities in the same market don't re-fetch.

import { getJson } from "./http.js";
import type { Category, Sport } from "./types.js";

const GAMMA_API = process.env.POLY_GAMMA_API || "https://gamma-api.polymarket.com";

type GammaMarket = { slug?: string; question?: string; events?: { slug?: string; title?: string }[] };

// Result of classifying a market: its top-level category (for grouping in the
// digest) plus the specific sport when category === "SPORTS" (drives the emoji).
export type Classification = { category: Category; sport: Sport };

const cache = new Map<string, Classification>();

// ── Report filter ──────────────────────────────────────────────────────────
// We only notify on MLB single games and World Cup single games. Everything
// else (championship/futures markets like "Will England win the World Cup?",
// other sports such as tennis/NBA, politics, crypto) is recorded to the DB but
// NOT pushed. The decision is made on the market SLUG, which is structured and
// reliable: MLB single games are "mlb-<away>-<home>-<date>", World Cup single
// games carry a worldcup/fifa-match prefix. Futures slugs read like
// "will-england-win-..." and are explicitly excluded.

export type ReportKind = "MLB_GAME" | "WC_GAME";

const FUTURES_SLUG = /\bwill-.*-win\b|win-the-.*world-cup|-to-win-/i;
const MLB_GAME_SLUG = /^mlb-[a-z]+-[a-z]+-\d{4}-\d{2}-\d{2}/i;
// World Cup single-match slugs. Polymarket hasn't published 2026 group-stage
// match slugs yet; cover the likely shapes (worldcup-/fifa-/wc-) for a single
// fixture with a date, while the futures regex above strips "win the world cup".
const WC_GAME_SLUG = /^(worldcup|world-cup|fifa|wc)-[a-z]+-[a-z]+-\d{4}-\d{2}-\d{2}/i;

// Turn a market slug + outcome into a human-readable bet description, so a
// notification never shows a bare "Under" with no context. MLB markets come in
// three shapes (verified against live positions):
//   bare              "mlb-atl-cws-2026-06-11"            → moneyline (outcome = team)
//   -total-9pt5       "...-total-9pt5"        outcome O/U → 大小分 9.5 Over/Under
//   -spread-home-1pt5 "...-spread-home-1pt5"  outcome=team→ 讓分 主-1.5 押 <team>
// Returns "押 <團隊>" for moneyline, or a labelled description otherwise.
export function describeBet(slug = "", outcome = ""): string {
  const o = outcome.trim();
  // points line like "9pt5" → "9.5"
  const ptsMatch = /(\d+)pt(\d+)/i.exec(slug);
  const line = ptsMatch ? `${ptsMatch[1]}.${ptsMatch[2]}` : "";

  if (/-total-/i.test(slug)) {
    // 大小分: outcome is Over / Under
    return `大小分 ${line}${line ? " " : ""}${o}`;
  }
  if (/-spread-(home|away)-/i.test(slug)) {
    // 讓分: home/away ± line, outcome is the team taken
    const side = /-spread-home-/i.test(slug) ? "主" : "客";
    return `讓分 ${side}-${line} 押 ${o}`;
  }
  // moneyline (or anything else) — outcome is the team
  return `押 ${o}`;
}

/**
 * Decide whether a market (by its slug) is one we report on, and as what.
 * Returns null for anything that should be recorded but not notified.
 */
export function reportKind(slug = "", title = ""): ReportKind | null {
  const s = slug.toLowerCase();
  const t = title.toLowerCase();
  if (FUTURES_SLUG.test(s) || /\bwill\b.*\bwin\b/.test(t)) return null; // futures
  if (MLB_GAME_SLUG.test(s)) return "MLB_GAME";
  if (WC_GAME_SLUG.test(s)) return "WC_GAME";
  return null;
}

// Sport keyword sets. SOCCER intentionally broad (World Cup, EPL, UEFA, etc.).
const SPORT_RULES: { sport: Sport; kw: RegExp }[] = [
  { sport: "MLB", kw: /\b(mlb|yankees|red-?sox|dodgers|world-series|baseball)\b/i },
  { sport: "NBA", kw: /\b(nba|lakers|celtics|warriors|playoffs|finals|basketball)\b/i },
  {
    sport: "SOCCER",
    kw: /\b(soccer|football|world-?cup|fifa|uefa|premier-?league|epl|laliga|la-liga|champions-?league|bundesliga|serie-a)\b/i,
  },
];

// Non-sport category keyword sets, checked after sports. Order matters: first
// match wins. Add categories here (e.g. ECON) as the watchlist grows.
const CATEGORY_RULES: { category: Category; kw: RegExp }[] = [
  {
    category: "CRYPTO",
    kw: /\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|dogecoin|doge|xrp|ripple|stablecoin|defi)\b/i,
  },
  {
    category: "POLITICS",
    kw: /\b(election|president|presidential|trump|biden|harris|senate|congress|primary|governor|parliament|vote|選舉)\b/i,
  },
];

function classifyText(text: string): Classification {
  for (const r of SPORT_RULES) if (r.kw.test(text)) return { category: "SPORTS", sport: r.sport };
  for (const r of CATEGORY_RULES) if (r.kw.test(text)) return { category: r.category, sport: "OTHER" };
  return { category: "OTHER", sport: "OTHER" };
}

/**
 * Classify a market by conditionId. Tries slug/title/event from Gamma; falls
 * back to whatever text we already have (the activity title) if Gamma is
 * unreachable for that market.
 */
export async function classify(conditionId: string, fallbackTitle = ""): Promise<Classification> {
  const cached = cache.get(conditionId);
  if (cached) return cached;

  let text = fallbackTitle;
  try {
    const markets = await getJson<GammaMarket[]>(
      `${GAMMA_API}/markets?condition_ids=${conditionId}`,
    );
    const m = markets?.[0];
    if (m) {
      text = [m.slug, m.question, m.events?.[0]?.slug, m.events?.[0]?.title, fallbackTitle]
        .filter(Boolean)
        .join(" ");
    }
  } catch {
    // Gamma lookup failed — fall back to the activity title text we already have.
  }

  const result = classifyText(text);
  cache.set(conditionId, result);
  return result;
}
