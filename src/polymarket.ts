// Fetch a watched address's recent on-chain activity from the public
// Polymarket Data API. No auth needed; accepts any wallet in the `user` param.
// This is the "track an address" core: given an address, return what it bet.

import { getJson } from "./http.js";
import type { RawActivity } from "./types.js";

const DATA_API = process.env.POLY_DATA_API || "https://data-api.polymarket.com";

/**
 * Get the most recent TRADE activities for one address, newest first.
 * `limit` caps results per poll (we only care about what's new since last run).
 */
export async function getActivity(address: string, limit = 40): Promise<RawActivity[]> {
  const url =
    `${DATA_API}/activity?user=${address.toLowerCase()}` +
    `&type=TRADE&limit=${limit}&sortBy=TIMESTAMP`;
  const data = await getJson<RawActivity[]>(url);
  return Array.isArray(data) ? data : [];
}

// A current holding (open or settled) from the Data API /positions endpoint.
// We use it to answer "which markets does this wallet currently hold a
// position in" — cross-referenced against today's MLB games by conditionId.
export type RawPosition = {
  conditionId: string;
  title: string;
  slug: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  redeemable: boolean;
};

/** Get one address's current positions (newest holdings). */
export async function getPositions(address: string, limit = 300): Promise<RawPosition[]> {
  const url = `${DATA_API}/positions?user=${address.toLowerCase()}&limit=${limit}`;
  const data = await getJson<RawPosition[]>(url);
  return Array.isArray(data) ? data : [];
}
