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

/** The US calendar date (YYYY-MM-DD) for "today's" Taipei slate = Taipei date − 1 day. */
function usSlateDate(now: Date): string {
  // Taipei wall-clock date, then step back one day to the US date.
  const tpe = new Date(now.getTime() + 8 * 3600 * 1000);
  const usDay = new Date(Date.UTC(tpe.getUTCFullYear(), tpe.getUTCMonth(), tpe.getUTCDate() - 1));
  const y = usDay.getUTCFullYear();
  const m = String(usDay.getUTCMonth() + 1).padStart(2, "0");
  const d = String(usDay.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * All MLB games on today's Taipei slate (= US "yesterday"'s date). One row per
 * game, keyed by slug prefix. Selection is purely by the slug's date.
 */
export async function getTodayMlbGames(now = new Date()): Promise<MlbGame[]> {
  const slateDate = usSlateDate(now); // e.g. "2026-06-12"

  let events: GammaEvent[] = [];
  try {
    events = await getJson<GammaEvent[]>(
      `${GAMMA_API}/events?closed=false&limit=120&order=startDate&ascending=true&tag_slug=baseball`,
    );
  } catch {
    events = [];
  }
  if (!Array.isArray(events)) return [];

  const byKey = new Map<string, MlbGame>();
  for (const e of events) {
    const slug = e.slug || e.markets?.[0]?.slug || "";
    const gameKey = gameKeyFromSlug(slug);
    if (!gameKey || byKey.has(gameKey)) continue;
    if (!gameKey.endsWith(slateDate)) continue; // only today's US slate

    const { away, home } = teamsFromSlug(gameKey);
    if (!away || !home) continue;

    byKey.set(gameKey, { gameKey, away, home, title: e.title || `${away} vs ${home}` });
  }
  return [...byKey.values()].sort((a, b) => a.gameKey.localeCompare(b.gameKey));
}

/** "6/13" — the Taipei date label for the report header. */
export function tpeDateLabel(now = new Date()): string {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()}`;
}
