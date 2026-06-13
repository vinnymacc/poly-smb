// Fetch the MLB slate you (in Taiwan) wake up to today. US games are listed
// under the US calendar date, which lags Taipei by ~1 day: "Taipei 6/13's
// games" = the games whose slug date is the US date 6/12. We select by the
// slug date, not by a Taipei clock window. Used by src/mlb-report.ts.

import { getJson } from "./http.js";

const GAMMA_API = process.env.POLY_GAMMA_API || "https://gamma-api.polymarket.com";

/** Slug prefix identifying a game: "mlb-chc-sf-2026-06-12-total-7pt5" → "mlb-chc-sf-2026-06-12". */
export function gameKeyFromSlug(slug: string): string {
  const m = /^(mlb-[a-z]+-[a-z]+-\d{4}-\d{2}-\d{2})/i.exec(slug || "");
  return m ? m[1].toLowerCase() : "";
}

type GammaEvent = {
  slug?: string;
  title?: string;
  startTime?: string; // ISO UTC — actual first-pitch
  markets?: { conditionId?: string; slug?: string; gameStartTime?: string }[];
};

export type MlbGame = {
  // One game = slug prefix "mlb-<away>-<home>-<date>". A game has several
  // markets (moneyline, totals, spread) sharing this prefix; we key on it.
  gameKey: string;
  away: string; // "STL" (from slug)
  home: string; // "MIN"
  title: string; // "St. Louis Cardinals vs. Minnesota Twins"
};

/** Teams from a game slug: "mlb-stl-min-2026-06-12" → { away:"STL", home:"MIN" }. */
function teamsFromSlug(slug: string): { away: string; home: string } {
  const m = /^mlb-([a-z]+)-([a-z]+)-\d{4}-\d{2}-\d{2}/i.exec(slug || "");
  return m ? { away: m[1].toUpperCase(), home: m[2].toUpperCase() } : { away: "", home: "" };
}

/** Today's date (YYYY-MM-DD) in Taipei. */
function tpeToday(now: Date): string {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The slug's game date, e.g. "mlb-stl-min-2026-06-13" → "2026-06-13". */
function slugDate(gameKey: string): string {
  return gameKey.slice(-10);
}

/**
 * The "next slate": all MLB games on the SOONEST game-date that is today or
 * later (by slug date, Taipei). The three daily report runs (00:10 / 08:30 /
 * 17:00 Taipei) all land on the same slate this way — they're snapshots of the
 * same upcoming games at different times, not different days. Picking by
 * "earliest date >= today" is robust to schedule delay and to crossing midnight.
 */
export async function getTodayMlbGames(now = new Date()): Promise<MlbGame[]> {
  const today = tpeToday(now);

  let events: GammaEvent[] = [];
  try {
    events = await getJson<GammaEvent[]>(
      `${GAMMA_API}/events?closed=false&limit=120&order=startDate&ascending=true&tag_slug=baseball`,
    );
  } catch {
    events = [];
  }
  if (!Array.isArray(events)) return [];

  // One row per game; remember each game's slug date.
  const byKey = new Map<string, MlbGame & { date: string }>();
  for (const e of events) {
    const slug = e.slug || e.markets?.[0]?.slug || "";
    const gameKey = gameKeyFromSlug(slug);
    if (!gameKey || byKey.has(gameKey)) continue;
    const date = slugDate(gameKey);
    if (date < today) continue; // skip games already in the past

    const { away, home } = teamsFromSlug(gameKey);
    if (!away || !home) continue;

    byKey.set(gameKey, { gameKey, away, home, title: e.title || `${away} vs ${home}`, date });
  }

  const all = [...byKey.values()];
  if (all.length === 0) return [];

  // Earliest upcoming game-date = the slate we report on.
  const slate = all.reduce((min, g) => (g.date < min ? g.date : min), all[0].date);
  return all
    .filter((g) => g.date === slate)
    .sort((a, b) => a.gameKey.localeCompare(b.gameKey))
    .map(({ gameKey, away, home, title }) => ({ gameKey, away, home, title }));
}

/** "6/13" — the Taipei date label for the report header. */
export function tpeDateLabel(now = new Date()): string {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()}`;
}
