/**
 * The pool's math, exactly as the program does it (crate `pool-math`): a
 * constant-product curve over `btc = real + virtual` and the Rune reserve.
 * Fees are always BTC: a buy pays them from the BTC going in (before the
 * swap), a sale from the BTC coming out (after it). Amounts out round down,
 * fees round up. A quote here equals what the program will do on the same
 * pool state.
 */
export const BPS = 10_000n;
export const MAX_FEE_BPS = 1_000;
const U64 = (1n << 64n) - 1n;

export interface FeeRate {
  feeBps: number;
  creatorBps: number;
}
export interface Fee {
  total: bigint;
  creator: bigint;
  /** Etchy's part. */
  protocol: bigint;
}
export interface Reserves {
  btcReal: bigint;
  btcVirtual: bigint;
  rune: bigint;
}
export interface BuyQuote {
  btcIn: bigint;
  fee: Fee;
  btcToPool: bigint;
  runeOut: bigint;
}
export interface SellQuote {
  runeIn: bigint;
  btcFromPool: bigint;
  fee: Fee;
  btcOut: bigint;
}

export class PoolMathError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new PoolMathError(code);
};

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function feeOn(amount: bigint, rate: FeeRate): Fee {
  if (rate.feeBps > MAX_FEE_BPS || rate.creatorBps > rate.feeBps)
    fail('BadFee');
  const total = ceilDiv(amount * BigInt(rate.feeBps), BPS);
  const creator = (amount * BigInt(rate.creatorBps)) / BPS;
  return { total, creator, protocol: total - creator };
}

export const btcSide = (p: Reserves) => p.btcReal + p.btcVirtual;

/** Runes out for `btcIn` sats of WBTC (fee first). */
export function quoteBuy(p: Reserves, btcIn: bigint, rate: FeeRate): BuyQuote {
  if (btcIn <= 0n) fail('ZeroAmount');
  if (btcIn > U64) fail('Overflow');
  const fee = feeOn(btcIn, rate);
  const dx = btcIn - fee.total;
  if (dx === 0n) fail('ZeroOutput');
  if (p.btcReal + dx > U64) fail('Overflow');
  const runeOut = (p.rune * dx) / (btcSide(p) + dx);
  if (runeOut === 0n) fail('ZeroOutput');
  if (runeOut >= p.rune) fail('InsufficientLiquidity');
  return { btcIn, fee, btcToPool: dx, runeOut };
}

/** Sats of WBTC out for `runeIn` units (fee after). */
export function quoteSell(
  p: Reserves,
  runeIn: bigint,
  rate: FeeRate,
): SellQuote {
  if (runeIn <= 0n) fail('ZeroAmount');
  const gross = (btcSide(p) * runeIn) / (p.rune + runeIn);
  if (gross > p.btcReal) fail('InsufficientLiquidity');
  const fee = feeOn(gross, rate);
  const btcOut = gross - fee.total;
  if (btcOut === 0n) fail('ZeroOutput');
  return { runeIn, btcFromPool: gross, fee, btcOut };
}

/** The smallest `btcIn` that buys at least `runeOut`. */
export function quoteBuyExactOut(
  p: Reserves,
  runeOut: bigint,
  rate: FeeRate,
): BuyQuote {
  if (runeOut <= 0n) fail('ZeroAmount');
  if (runeOut >= p.rune) fail('InsufficientLiquidity');
  const dx = ceilDiv(btcSide(p) * runeOut, p.rune - runeOut);
  let btcIn = ceilDiv(dx * BPS, BPS - BigInt(rate.feeBps));
  for (let i = 0; i < 8; i++) {
    const q = quoteBuy(p, btcIn, rate);
    if (q.runeOut >= runeOut) return q;
    btcIn += 1n;
  }
  return fail('Overflow');
}

export function afterBuy(p: Reserves, q: BuyQuote): Reserves {
  return {
    btcReal: p.btcReal + q.btcToPool,
    btcVirtual: p.btcVirtual,
    rune: p.rune - q.runeOut,
  };
}
export function afterSell(p: Reserves, q: SellQuote): Reserves {
  return {
    btcReal: p.btcReal - q.btcFromPool,
    btcVirtual: p.btcVirtual,
    rune: p.rune + q.runeIn,
  };
}

/** Sats per WHOLE Rune, 18 decimals (the program's `price_e18`). */
export function priceE18(p: Reserves, divisibility: number): bigint {
  if (p.rune === 0n) return 0n;
  return (btcSide(p) * 10n ** BigInt(divisibility) * 10n ** 18n) / p.rune;
}

/** A minimum out allowing `slippageBps` of price movement. */
export const withSlippage = (out: bigint, slippageBps: number) =>
  (out * (BPS - BigInt(slippageBps))) / BPS;
