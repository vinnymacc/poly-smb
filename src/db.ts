// Local SQLite store using Node 24's built-in node:sqlite (no native compile).
// Two jobs:
//   1. seen-dedup: remember every txHash we've already processed, so the same
//      bet never notifies twice.
//   2. history: keep a full normalized record of every bet (for a future
//      internal dashboard — see plan "integration path A").
//
// Cold start: the very first time we see an address, we record its current
// activity as baseline WITHOUT notifying, so we don't dump hundreds of old
// bets into Telegram on first run.

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "smartmoney.db");

import type { Bet } from "./types.js";

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS seen (
    tx_hash TEXT PRIMARY KEY,
    ts      INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bets (
    tx_hash      TEXT PRIMARY KEY,
    wallet       TEXT NOT NULL,
    label        TEXT NOT NULL,
    sport        TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT 'OTHER',
    market       TEXT NOT NULL,
    outcome      TEXT NOT NULL,
    side         TEXT NOT NULL,
    price        REAL NOT NULL,
    usd          REAL NOT NULL,
    timestamp    INTEGER NOT NULL,
    condition_id TEXT NOT NULL,
    tx_url       TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS baselined (
    wallet TEXT PRIMARY KEY,
    ts     INTEGER NOT NULL
  );
`);

// Migration: add `category` to a pre-existing bets table. CREATE TABLE IF NOT
// EXISTS won't alter an existing table, so add the column if it's missing.
const betCols = db.prepare("PRAGMA table_info(bets)").all() as { name: string }[];
if (!betCols.some((c) => c.name === "category")) {
  db.exec("ALTER TABLE bets ADD COLUMN category TEXT NOT NULL DEFAULT 'OTHER'");
}

const hasSeen = db.prepare("SELECT 1 FROM seen WHERE tx_hash = ?");
const markSeen = db.prepare("INSERT OR IGNORE INTO seen (tx_hash, ts) VALUES (?, ?)");
const insertBet = db.prepare(`
  INSERT OR IGNORE INTO bets
    (tx_hash, wallet, label, sport, category, market, outcome, side, price, usd, timestamp, condition_id, tx_url)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const isBaselinedStmt = db.prepare("SELECT 1 FROM baselined WHERE wallet = ?");
const setBaselined = db.prepare("INSERT OR IGNORE INTO baselined (wallet, ts) VALUES (?, ?)");

export function seen(txHash: string): boolean {
  return hasSeen.get(txHash) != null;
}

export function isBaselined(wallet: string): boolean {
  return isBaselinedStmt.get(wallet.toLowerCase()) != null;
}

export function markBaselined(wallet: string, ts: number): void {
  setBaselined.run(wallet.toLowerCase(), ts);
}

/** Record a bet (history + seen). Idempotent on txHash. */
export function recordBet(b: Bet): void {
  insertBet.run(
    b.txHash,
    b.wallet,
    b.label,
    b.sport,
    b.category,
    b.market,
    b.outcome,
    b.side,
    b.price,
    b.usd,
    b.timestamp,
    b.conditionId,
    b.txUrl,
  );
  markSeen.run(b.txHash, b.timestamp);
}

/** Mark a txHash seen without storing a full bet (used for baseline). */
export function markSeenOnly(txHash: string, ts: number): void {
  markSeen.run(txHash, ts);
}
