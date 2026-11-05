/**
 * M129 the Ordinals shelf, as the program does it (`rune_pool::shelf`): the
 * pool buys a minted Ordinal back at its Runes' value less the shelf fee,
 * and sells the Ordinals it holds at their Runes' value. Quotes here equal
 * what the program will do on the same pool state.
 *
 * - Sold back: a SALE of the collection's `unit` Runes into the pool; the
 *   shelf fee stays in the pool's BTC. Those Runes are the Ordinal on the
 *   shelf (`shelfRunes`): no other buy may take them.
 * - Bought off the shelf: the cheapest BUY of at least `unit` Runes; exactly
 *   `unit` leave the reserve with the Ordinal.
 * - Selling to the shelf on Bitcoin: the Ordinal alone on the first sat of
 *   an output of at least `SHELF_COIN_SATS` to the pool's shelf address,
 *   with the memo `OP_RETURN "ETCH" <owner> <lowest price>` (`sellMemo`).
 */
import { PublicKey } from '@solana/web3.js';
import {
  BPS,
  PoolMathError,
  afterBuy,
  afterSell,
  quoteBuyExactOut,
  quoteSell,
  type BuyQuote,
  type FeeRate,
  type Reserves,
  type SellQuote,
} from './math.ts';
import { concat, le } from './borsh.ts';

/** Deck bytes (`Collection` states) beyond M123's FREE 0, OUT 2, SENDING 3. */
export const ITEM_SHELF = 4;
export const ITEM_SHELF_SENDING = 5;
export const ITEM_SELLING = 6;
export const ITEM_LOST = 7;

/** `OrdCoin.state`. */
export const OC_AWAITING = 0;
export const OC_HELD = 1;
export const OC_SELLING = 2;
export const OC_SHELF = 3;
export const OC_LEAVING = 4;
export const OC_STUCK = 5;
export const OC_LOST = 6;

/** The shelf fee until the fee authority sets another (bps), and its cap. */
export const SHELF_FEE_BPS = 500;
export const MAX_SHELF_FEE_BPS = 2_000;
/** A coin sold back carries its own way out (the vault's send pays from it). */
export const SHELF_COIN_SATS = 5_000n;
/** Inputs before the Ordinal's whose previous transactions a follow proof carries, at most. */
export const MAX_INPUTS_BEFORE = 8;
/** `OrdCoin::SPACE` (its rent: paid by its minter at take-out). */
export const ORD_COIN_SPACE = 282;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** What the pool pays for an Ordinal of `unit` Runes now. */
export interface SellBackQuote {
  /** The sale of `unit` Runes (with the pool's normal sell fee). */
  sale: SellQuote;
  /** The shelf fee: stays in the pool. */
  kept: bigint;
  /** To the seller (sats of WBTC). */
  paid: bigint;
  after: Reserves;
}
export function sellBackQuote(
  p: Reserves,
  unit: bigint,
  rate: FeeRate,
  feeBps: number,
): SellBackQuote {
  if (feeBps > MAX_SHELF_FEE_BPS) throw new PoolMathError('BadFee');
  const sale = quoteSell(p, unit, rate);
  const kept = ceilDiv(sale.btcOut * BigInt(feeBps), BPS);
  const paid = sale.btcOut - kept;
  if (paid === 0n) throw new PoolMathError('ZeroOutput');
  const a = afterSell(p, sale);
  return { sale, kept, paid, after: { ...a, btcReal: a.btcReal + kept } };
}

/** What buying an Ordinal of `unit` Runes off the shelf costs now. */
export interface ShelfBuyQuote {
  buy: BuyQuote;
  after: Reserves;
}
/** `shelfRunes`: the shelf's Runes, this Ordinal's included. */
export function shelfBuyQuote(
  p: Reserves,
  unit: bigint,
  rate: FeeRate,
  shelfRunes: bigint,
): ShelfBuyQuote {
  if (unit === 0n || shelfRunes < unit || p.rune < shelfRunes)
    throw new PoolMathError('InsufficientLiquidity');
  const buy = quoteBuyExactOut(p, unit, rate);
  return { buy, after: { ...afterBuy(p, buy), rune: p.rune - unit } };
}

/** A buy that leaves `runeAfter` in the reserve: never below the shelf's Runes. */
export const buyLeavesShelf = (runeAfter: bigint, shelfRunes: bigint) =>
  runeAfter >= shelfRunes;

/** `Pool.reserved[0..16]`: the pool's Runes that are Ordinals on its shelf. */
export function shelfRunesOf(reserved: Uint8Array): bigint {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(reserved[i] ?? 0);
  return v;
}
/** `OrdConfig.reserved`: the shelf fee (bps). */
export function shelfFeeOf(reserved: Uint8Array): number {
  return reserved[0] === 1 ? reserved[1] | (reserved[2] << 8) : SHELF_FEE_BPS;
}
/** `Collection.reserved`: the shelf's script and its counters. */
export function shelfOfCollection(reserved: Uint8Array) {
  const n = Math.min(reserved[0] ?? 0, 34);
  const count = (at: number) => reserved[at] | (reserved[at + 1] << 8);
  return {
    script: Uint8Array.from(reserved.subarray(1, 1 + n)),
    onShelf: count(35),
    selling: count(37),
    leaving: count(39),
    lost: count(41),
  };
}

/**
 * The seller's memo (an OP_RETURN script, 46 bytes): who the pool pays
 * (a Solana wallet, or a Bitcoin wallet's owner address) and the lowest
 * price it takes (sats).
 */
export function sellMemo(owner: PublicKey, minSats: bigint): Uint8Array {
  if (minSats < 0n || minSats >= 1n << 64n)
    throw new Error('lowest price out of range');
  return concat(
    Uint8Array.from([0x6a, 44]),
    new TextEncoder().encode('ETCH'),
    owner.toBytes(),
    le(minSats, 8),
  );
}

/** Where the sat at `offset` of all inputs lands among `outputs` (values): null = to the miner. */
export function land(
  outputs: bigint[],
  offset: bigint,
): { vout: number; offset: bigint } | null {
  let start = 0n;
  for (let j = 0; j < outputs.length; j++) {
    const end = start + outputs[j];
    if (offset < end) return { vout: j, offset: offset - start };
    start = end;
  }
  return null;
}

/**
 * A follow proof (`rune_pool::FollowProof`, written to a proof buffer):
 * the transaction spending the Ordinal's coin, its Merkle branch, the
 * block's coinbase and branch when the branch needs the block's depth, and
 * the previous transactions of the inputs before the Ordinal's (whole).
 */
export function followPayload(p: {
  tx: Uint8Array;
  branch: Uint8Array[];
  coinbase?: { tx: Uint8Array; branch: Uint8Array[] } | null;
  prevs: Uint8Array[];
}): Uint8Array {
  if (p.prevs.length > MAX_INPUTS_BEFORE)
    throw new Error('too many inputs before the Ordinal');
  const bytes = (b: Uint8Array) => concat(le(b.length, 4), b);
  const branch = (b: Uint8Array[]) => concat(Uint8Array.from([b.length]), ...b);
  const parts = [bytes(p.tx), branch(p.branch)];
  if (p.coinbase)
    parts.push(
      Uint8Array.from([1]),
      bytes(p.coinbase.tx),
      branch(p.coinbase.branch),
    );
  else parts.push(Uint8Array.from([0]));
  parts.push(Uint8Array.from([p.prevs.length]), ...p.prevs.map(bytes));
  return concat(...parts);
}
