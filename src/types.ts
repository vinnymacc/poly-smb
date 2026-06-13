// Raw shape returned by the Polymarket Data API /activity endpoint
// (verified against live data — see dns-test.ts output).
export type RawActivity = {
  proxyWallet: string;
  timestamp: number; // unix seconds
  conditionId: string;
  type: string; // "TRADE" | "SPLIT" | ...
  size: number; // outcome-token amount
  usdcSize: number; // USD amount
  transactionHash: string;
  price: number; // 0..1 — the entry "point" (probability)
  asset: string;
  side: "BUY" | "SELL";
  outcomeIndex: number;
  title: string;
  slug: string;
  eventSlug?: string;
  outcome: string; // which side, e.g. "Yes" / team name
  name?: string;
  pseudonym?: string;
};

// Which specific sport a market is (used for the emoji on a sports row).
export type Sport = "MLB" | "NBA" | "SOCCER" | "OTHER";

// Top-level bucket a market falls into. Sports are collapsed into one SPORTS
// category for grouping; the specific Sport is kept on the bet for its emoji.
export type Category = "SPORTS" | "CRYPTO" | "POLITICS" | "OTHER";

// A watched address from config/watchlist.json. `tags` marks which sports the
// wallet is tracked for (e.g. ["MLB"], ["WC"], or both); optional for back-compat.
export type Watched = { address: string; label: string; tags?: string[] };

// Normalized bet we store + notify on.
export type Bet = {
  wallet: string;
  label: string;
  sport: Sport;
  category: Category;
  market: string;
  outcome: string;
  side: "BUY" | "SELL";
  price: number;
  usd: number;
  timestamp: number;
  conditionId: string;
  txHash: string;
  txUrl: string;
};
