import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import { ATA_PROGRAM, TOKEN_PROGRAM } from './client.ts';

/**
 * Add BTC through NEAR Intents, swapped to WBTC (the program's `sol_swap`):
 *
 * 1. The browser asks NEAR's 1Click API (it allows any web page) for a
 *    BTC -> SOL quote whose recipient is the wallet's SOL deposit address
 *    (`pda.btcSol(taproot key)`; nobody holds its key) and whose refunds go
 *    back to the user's own Bitcoin address. The wallet pays the quote's
 *    deposit address. Every quote has its own deposit address.
 * 2. Anyone (Etchy's keeper, another site, the user) swaps the SOL into WBTC
 *    in one transaction: `sol_swap_begin` -> any route into the wallet's
 *    swap inbox -> `sol_swap_end`. The program refuses less than Pyth's
 *    market value less the tolerance; the sender keeps a small fee.
 *
 * Withdraw to Bitcoin through NEAR, the same way back (`near_withdraw`):
 *
 * 1. A SOL -> BTC 1Click quote: recipient the user's Bitcoin address, refunds
 *    to the wallet's SOL deposit address (a failed swap comes back as SOL
 *    there and becomes WBTC again). NEAR answers with its Solana deposit
 *    address D and the SOL it wants (Y).
 * 2. The wallet signs "withdraw X BTC to <bc1...> through NEAR: sell it for
 *    at least Y SOL sent to NEAR's deposit address D".
 * 3. Anyone runs it in one transaction: `near_withdraw_begin` (X WBTC to the
 *    sender) -> the sender's swap to SOL -> Y SOL to D -> `near_withdraw_end`.
 *    The program refuses unless Y SOL (plus the sender's fee) is worth X
 *    less the tolerance at Pyth's prices.
 *
 * Here: Pyth price reading and the program's exact limits, the 1Click
 * quotes (checked field by field) and their status, and Jupiter routes.
 */
export const PYTH_RECEIVER = new PublicKey(
  'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ',
);
/** Pyth feed ids. */
export const BTC_USD_FEED =
  'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
export const SOL_USD_FEED =
  'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
/** Pyth's sponsored price accounts (shard 0; the same on mainnet and devnet). */
export const BTC_USD_ACCOUNT = new PublicKey(
  '4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo',
);
export const SOL_USD_ACCOUNT = new PublicKey(
  '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE',
);
const PRICE_UPDATE_V2 = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];

export interface PythPrice {
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: number;
}
const hexOf = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A Pyth `PriceUpdateV2` account, read exactly like the program does. */
export function parsePyth(data: Uint8Array, feedHex: string): PythPrice {
  if (data.length < 134 || PRICE_UPDATE_V2.some((b, i) => data[i] !== b))
    throw new Error('not a Pyth price update');
  if (data[40] !== 1) throw new Error('Pyth price not fully verified');
  const m = data.subarray(41);
  if (hexOf(m.subarray(0, 32)) !== feedHex) throw new Error('wrong Pyth feed');
  const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
  const price = v.getBigInt64(32, true);
  const expo = v.getInt32(48, true);
  if (price <= 0n || expo > 0 || expo < -18) throw new Error('bad Pyth price');
  return {
    price,
    conf: v.getBigUint64(40, true),
    expo,
    publishTime: Number(v.getBigInt64(52, true)),
  };
}

/** Sats worth `lamports` of SOL (rounded down; `rune_pool::sats_for_lamports`). */
export function satsForLamports(
  lamports: bigint,
  sol: PythPrice,
  btc: PythPrice,
): bigint {
  const d = sol.expo - btc.expo;
  let num = lamports * sol.price;
  let den = btc.price * 10n;
  if (d >= 0) num *= 10n ** BigInt(d);
  else den *= 10n ** BigInt(-d);
  return num / den;
}

export interface SolSwapSettings {
  btcFeed: string;
  solFeed: string;
  maxAgeSecs: number;
  maxConfBps: number;
  toleranceBps: number;
  swapFeeLamports: bigint;
  minLamports: bigint;
  paused: boolean;
}

/** The least WBTC a swap of `lamports` must deliver (`rune_pool::min_swap_out`). */
export function minSwapOut(
  lamports: bigint,
  sol: PythPrice,
  btc: PythPrice,
  s: Pick<SolSwapSettings, 'swapFeeLamports' | 'toleranceBps'>,
): bigint {
  if (lamports <= s.swapFeeLamports) return 0n;
  const value = satsForLamports(lamports - s.swapFeeLamports, sol, btc);
  return (value * BigInt(10_000 - s.toleranceBps)) / 10_000n;
}

/** Lamports worth `sats` (rounded down): the inverse of `satsForLamports`. */
export function lamportsForSats(
  sats: bigint,
  sol: PythPrice,
  btc: PythPrice,
): bigint {
  const d = sol.expo - btc.expo;
  let num = sats * btc.price * 10n;
  let den = sol.price;
  if (d >= 0) den *= 10n ** BigInt(d);
  else num *= 10n ** BigInt(-d);
  return num / den;
}

/**
 * Whether `near_withdraw_begin` accepts selling `amount` sats of WBTC for
 * at least `minLamports` of SOL: that SOL plus the sender's fee must be
 * worth the amount less the tolerance.
 */
export function nearWithdrawAllowed(
  amount: bigint,
  minLamports: bigint,
  sol: PythPrice,
  btc: PythPrice,
  s: Pick<SolSwapSettings, 'swapFeeLamports' | 'toleranceBps' | 'minLamports'>,
): boolean {
  if (amount <= 0n || minLamports < s.minLamports) return false;
  const worth = satsForLamports(minLamports + s.swapFeeLamports, sol, btc);
  return worth >= (amount * BigInt(10_000 - s.toleranceBps)) / 10_000n;
}
/** The least SOL a withdrawal of `amount` sats may be sold for now. */
export function nearWithdrawFloor(
  amount: bigint,
  sol: PythPrice,
  btc: PythPrice,
  s: Pick<SolSwapSettings, 'swapFeeLamports' | 'toleranceBps' | 'minLamports'>,
): bigint {
  const target = (amount * BigInt(10_000 - s.toleranceBps)) / 10_000n;
  // Rounded up, so it is enough at once (the loop is only a guard).
  let y = lamportsForSats(target, sol, btc) + 1n - s.swapFeeLamports;
  if (y < s.minLamports) y = s.minLamports;
  while (!nearWithdrawAllowed(amount, y, sol, btc, s)) y += 1n;
  return y;
}

/** Whether the program would accept this price now (fresh and tight). */
export function priceUsable(
  p: PythPrice,
  s: Pick<SolSwapSettings, 'maxAgeSecs' | 'maxConfBps'>,
  nowSecs: number,
): boolean {
  return (
    p.publishTime <= nowSecs + 60 &&
    nowSecs - p.publishTime <= s.maxAgeSecs &&
    p.conf * 10_000n <= p.price * BigInt(s.maxConfBps)
  );
}

// ---------------------------------------------------------------- NEAR 1Click (from the browser)
export const ONECLICK_URL = 'https://1click.chaindefuser.com';
/** NEAR's names for native BTC and native SOL. */
export const NEAR_BTC = '1cs_v1:btc:native:coin';
const NEAR_BTC_IDS = new Set([NEAR_BTC, 'nep141:btc.omft.near']);
export const NEAR_SOL = 'nep141:sol.omft.near';
/** NEAR refuses less (sats). */
export const NEAR_MIN_SATS = 8_300n;

export interface NearQuote {
  /** Pay exactly `amountIn` sats here (one transaction). */
  depositAddress: string;
  amountIn: bigint;
  /** Lamports NEAR expects to deliver, and at least. */
  amountOut: bigint;
  minAmountOut: bigint;
  deadline: string;
  timeEstimateSecs: number | null;
}

/**
 * A BTC -> SOL quote paying the wallet's SOL deposit address; refunds to
 * `refundTo` (the user's own Bitcoin address). Checked field by field:
 * never pay a quote this does not return.
 */
export async function nearAddQuote(
  p: {
    sats: bigint;
    /** `pda.btcSol(key)` of the wallet. */
    depositSol: PublicKey;
    refundTo: string;
    slippageBps?: number;
    /** A partner key (a server only; never in a browser). */
    apiKey?: string;
    dry?: boolean;
  },
  f: typeof fetch = fetch,
): Promise<NearQuote> {
  if (p.sats < NEAR_MIN_SATS)
    throw new Error(`NEAR takes at least ${NEAR_MIN_SATS} sats`);
  const request = {
    dry: !!p.dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: p.slippageBps ?? 100,
    originAsset: NEAR_BTC,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: NEAR_SOL,
    amount: p.sats.toString(),
    refundTo: p.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: p.depositSol.toBase58(),
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 3 * 3_600_000).toISOString(),
  };
  const r = await f(`${ONECLICK_URL}/v0/quote`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}),
    },
    body: JSON.stringify(request),
  });
  const j = (await r.json().catch(() => ({}))) as {
    message?: string;
    quote?: Record<string, unknown>;
    quoteRequest?: Record<string, unknown>;
  };
  if (!r.ok) throw new Error(`NEAR: ${j.message ?? r.status}`);
  const q = j.quote ?? {};
  const asked = j.quoteRequest ?? {};
  const sent = request as Record<string, unknown>;
  for (const k of [
    'recipient',
    'refundTo',
    'amount',
    'recipientType',
    'refundType',
    'depositType',
    'swapType',
  ])
    if (String(asked[k]) !== String(sent[k]))
      throw new Error(`NEAR quote mismatch: ${k}`);
  if (
    !NEAR_BTC_IDS.has(String(asked.originAsset)) ||
    asked.destinationAsset !== NEAR_SOL
  )
    throw new Error('NEAR quote mismatch: asset');
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  if (
    q.amountIn !== request.amount ||
    !/^\d{1,20}$/.test(str(q.amountOut)) ||
    !/^\d{1,20}$/.test(str(q.minAmountOut)) ||
    (q.depositMemo !== undefined &&
      q.depositMemo !== null &&
      q.depositMemo !== '') ||
    (!p.dry &&
      !/^(bc1[02-9ac-hj-np-z]{39,59}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(
        str(q.depositAddress),
      ))
  )
    throw new Error('NEAR quote malformed');
  return {
    depositAddress: p.dry ? '' : str(q.depositAddress),
    amountIn: BigInt(str(q.amountIn)),
    amountOut: BigInt(str(q.amountOut)),
    minAmountOut: BigInt(str(q.minAmountOut)),
    deadline: str(q.deadline) || request.deadline,
    timeEstimateSecs:
      typeof q.timeEstimate === 'number' ? q.timeEstimate : null,
  };
}

export interface NearWithdrawQuote {
  /** NEAR's Solana deposit address for this quote: send exactly `amountIn` lamports. */
  depositAddress: PublicKey;
  amountIn: bigint;
  /** Sats NEAR expects to pay to the Bitcoin address, and at least. */
  amountOut: bigint;
  minAmountOut: bigint;
  deadline: string;
  timeEstimateSecs: number | null;
}

/**
 * A SOL -> BTC quote paying `btcAddress`; refunds to the wallet's SOL
 * deposit address (`pda.btcSol(key)`), where `sol_swap` turns them back
 * into WBTC. Checked field by field.
 */
export async function nearWithdrawQuote(
  p: {
    lamports: bigint;
    btcAddress: string;
    /** `pda.btcSol(key)` of the wallet. */
    refundTo: PublicKey;
    slippageBps?: number;
    apiKey?: string;
    dry?: boolean;
    /** How long NEAR waits for the SOL (default 1 hour). */
    deadlineSecs?: number;
  },
  f: typeof fetch = fetch,
): Promise<NearWithdrawQuote> {
  if (
    !/^(bc1[02-9ac-hj-np-z]{39,59}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(
      p.btcAddress,
    )
  )
    throw new Error('not a Bitcoin mainnet address');
  const request = {
    dry: !!p.dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: p.slippageBps ?? 100,
    originAsset: NEAR_SOL,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: NEAR_BTC,
    amount: p.lamports.toString(),
    refundTo: p.refundTo.toBase58(),
    refundType: 'ORIGIN_CHAIN',
    recipient: p.btcAddress,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(
      Date.now() + (p.deadlineSecs ?? 3_600) * 1_000,
    ).toISOString(),
  };
  const r = await f(`${ONECLICK_URL}/v0/quote`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}),
    },
    body: JSON.stringify(request),
  });
  const j = (await r.json().catch(() => ({}))) as {
    message?: string;
    quote?: Record<string, unknown>;
    quoteRequest?: Record<string, unknown>;
  };
  if (!r.ok) throw new Error(`NEAR: ${j.message ?? r.status}`);
  const q = j.quote ?? {};
  const asked = j.quoteRequest ?? {};
  const sent = request as Record<string, unknown>;
  for (const k of [
    'recipient',
    'refundTo',
    'amount',
    'recipientType',
    'refundType',
    'depositType',
    'swapType',
  ])
    if (String(asked[k]) !== String(sent[k]))
      throw new Error(`NEAR quote mismatch: ${k}`);
  if (
    asked.originAsset !== NEAR_SOL ||
    !NEAR_BTC_IDS.has(String(asked.destinationAsset))
  )
    throw new Error('NEAR quote mismatch: asset');
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  let deposit: PublicKey | null = null;
  try {
    deposit = p.dry ? PublicKey.default : new PublicKey(str(q.depositAddress));
  } catch {
    deposit = null;
  }
  if (
    !deposit ||
    q.amountIn !== request.amount ||
    !/^\d{1,20}$/.test(str(q.amountOut)) ||
    !/^\d{1,20}$/.test(str(q.minAmountOut)) ||
    (q.depositMemo !== undefined &&
      q.depositMemo !== null &&
      q.depositMemo !== '')
  )
    throw new Error('NEAR quote malformed');
  return {
    depositAddress: deposit,
    amountIn: BigInt(str(q.amountIn)),
    amountOut: BigInt(str(q.amountOut)),
    minAmountOut: BigInt(str(q.minAmountOut)),
    deadline: str(q.deadline) || request.deadline,
    timeEstimateSecs:
      typeof q.timeEstimate === 'number' ? q.timeEstimate : null,
  };
}

/** A NEAR deposit's state (PENDING_DEPOSIT, PROCESSING, SUCCESS, REFUNDED, FAILED, ...). */
export async function nearStatus(
  depositAddress: string,
  f: typeof fetch = fetch,
): Promise<{ status: string; raw: unknown }> {
  const r = await f(
    `${ONECLICK_URL}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
  );
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(`NEAR status: ${r.status}`);
  return { status: String(j.status ?? 'UNKNOWN'), raw: j };
}

// ---------------------------------------------------------------- Jupiter route (mainnet)
export const JUPITER_URL = 'https://lite-api.jup.ag/swap/v1';
const WSOL = 'So11111111111111111111111111111111111111112';
/** Jupiter's aggregator (v6): the program of a route's swap (read from its API, 2026-10-22). */
export const JUPITER_PROGRAM = new PublicKey(
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
);
/** Accounts a route may name (with lookup tables it fits next to a pool instruction). */
export const JUPITER_MAX_ACCOUNTS = 40;
/**
 * A route's instructions only call Jupiter, the token program, the
 * associated token program and the system program (SOL wrapping): anything
 * else and the route is refused.
 */
export function routeProgramsOk(ixs: TransactionInstruction[]): boolean {
  const ok = new Set(
    [JUPITER_PROGRAM, TOKEN_PROGRAM, ATA_PROGRAM, SystemProgram.programId].map(
      (k) => k.toBase58(),
    ),
  );
  return ixs.every((ix) => ok.has(ix.programId.toBase58()));
}

/** A Jupiter price only (no instructions): SOL -> WBTC (`buy`) or WBTC -> SOL. */
export async function jupiterQuote(
  p: {
    buy: boolean;
    amount: bigint;
    wbtcMint: PublicKey;
    slippageBps?: number;
    maxAccounts?: number;
    baseUrl?: string;
    apiKey?: string;
  },
  f: typeof fetch = fetch,
): Promise<{ expectedOut: bigint; worstOut: bigint; impactPct: number }> {
  const [a, b] = p.buy
    ? [WSOL, p.wbtcMint.toBase58()]
    : [p.wbtcMint.toBase58(), WSOL];
  const r = await f(
    `${p.baseUrl ?? JUPITER_URL}/quote?inputMint=${a}&outputMint=${b}&amount=${p.amount}&slippageBps=${p.slippageBps ?? 50}&maxAccounts=${p.maxAccounts ?? JUPITER_MAX_ACCOUNTS}`,
    { headers: jupHeaders(p.apiKey) },
  );
  if (!r.ok) throw new Error(`Jupiter quote: ${r.status}`);
  const q = (await r.json()) as {
    outAmount: string;
    otherAmountThreshold: string;
    priceImpactPct?: string;
  };
  return {
    expectedOut: BigInt(q.outAmount),
    worstOut: BigInt(q.otherAmountThreshold),
    impactPct: Number(q.priceImpactPct ?? 0),
  };
}

/** Jupiter's paid API (api.jup.ag) takes its key in `x-api-key`. */
const jupHeaders = (apiKey?: string): Record<string, string> =>
  apiKey ? { 'x-api-key': apiKey } : {};

/** One Jupiter instruction as the swap-instructions API returns it. */
interface JupIx {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}
const toIx = (x: JupIx) =>
  new TransactionInstruction({
    programId: new PublicKey(x.programId),
    keys: x.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(x.data, 'base64'),
  });

/**
 * A Jupiter SOL -> WBTC route for `lamports` of the sender's SOL, paying the
 * wallet's swap inbox. Returns the instructions to put between
 * `sol_swap_begin` and `sol_swap_end`, their lookup tables and the WBTC
 * Jupiter expects (at least `minOut` or null).
 */
export async function jupiterRoute(
  p: {
    swapper: PublicKey;
    lamports: bigint;
    wbtcMint: PublicKey;
    /** The WBTC account paid: a wallet's swap inbox, or a buyer's own WBTC account. */
    inbox: PublicKey;
    minOut: bigint;
    slippageBps?: number;
    maxAccounts?: number;
    baseUrl?: string;
    apiKey?: string;
  },
  f: typeof fetch = fetch,
) {
  const base = p.baseUrl ?? JUPITER_URL;
  const qr = await f(
    `${base}/quote?inputMint=${WSOL}&outputMint=${p.wbtcMint.toBase58()}&amount=${p.lamports}&slippageBps=${p.slippageBps ?? 50}&maxAccounts=${p.maxAccounts ?? JUPITER_MAX_ACCOUNTS}`,
    { headers: jupHeaders(p.apiKey) },
  );
  if (!qr.ok) throw new Error(`Jupiter quote: ${qr.status}`);
  const quote = (await qr.json()) as {
    outAmount: string;
    otherAmountThreshold: string;
  };
  // Its own worst case must still meet the program's minimum.
  if (BigInt(quote.otherAmountThreshold) < p.minOut) return null;
  const sr = await f(`${base}/swap-instructions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...jupHeaders(p.apiKey) },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: p.swapper.toBase58(),
      destinationTokenAccount: p.inbox.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!sr.ok) throw new Error(`Jupiter swap-instructions: ${sr.status}`);
  return routeOf(quote, await sr.json());
}

type SwapInstructions = {
  setupInstructions?: JupIx[];
  swapInstruction: JupIx;
  cleanupInstruction?: JupIx | null;
  computeBudgetInstructions?: JupIx[];
  addressLookupTableAddresses?: string[];
  computeUnitLimit?: number;
};
/** A route from Jupiter's answer; refused if it calls anything unexpected. */
function routeOf(
  quote: { outAmount: string; otherAmountThreshold: string },
  s: SwapInstructions,
) {
  const instructions = [
    ...(s.setupInstructions ?? []),
    s.swapInstruction,
    ...(s.cleanupInstruction ? [s.cleanupInstruction] : []),
  ].map(toIx);
  if (s.swapInstruction?.programId !== JUPITER_PROGRAM.toBase58())
    throw new Error('Jupiter route: the swap is not Jupiter');
  if (!routeProgramsOk(instructions))
    throw new Error('Jupiter route: an unexpected program');
  return {
    expectedOut: BigInt(quote.outAmount),
    worstOut: BigInt(quote.otherAmountThreshold),
    computeBudget: (s.computeBudgetInstructions ?? []).map(toIx),
    /** Jupiter's simulated compute units for the swap alone (null: not given). */
    units:
      typeof s.computeUnitLimit === 'number' && s.computeUnitLimit > 0
        ? s.computeUnitLimit
        : null,
    instructions,
    lookupTables: (s.addressLookupTableAddresses ?? []).map(
      (a) => new PublicKey(a),
    ),
  };
}

/**
 * A Jupiter WBTC -> SOL route for a NEAR withdrawal: `sats` of the sender's
 * WBTC (just received from `near_withdraw_begin`) into the sender's own SOL.
 * Null unless its worst case is at least `minLamports` (the SOL the sender
 * must then pass on to NEAR).
 */
export async function jupiterSellRoute(
  p: {
    sender: PublicKey;
    sats: bigint;
    wbtcMint: PublicKey;
    minLamports: bigint;
    slippageBps?: number;
    maxAccounts?: number;
    baseUrl?: string;
    apiKey?: string;
  },
  f: typeof fetch = fetch,
) {
  const base = p.baseUrl ?? JUPITER_URL;
  const qr = await f(
    `${base}/quote?inputMint=${p.wbtcMint.toBase58()}&outputMint=${WSOL}&amount=${p.sats}&slippageBps=${p.slippageBps ?? 50}&maxAccounts=${p.maxAccounts ?? JUPITER_MAX_ACCOUNTS}`,
    { headers: jupHeaders(p.apiKey) },
  );
  if (!qr.ok) throw new Error(`Jupiter quote: ${qr.status}`);
  const quote = (await qr.json()) as {
    outAmount: string;
    otherAmountThreshold: string;
  };
  if (BigInt(quote.otherAmountThreshold) < p.minLamports) return null;
  const sr = await f(`${base}/swap-instructions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...jupHeaders(p.apiKey) },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: p.sender.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!sr.ok) throw new Error(`Jupiter swap-instructions: ${sr.status}`);
  return routeOf(quote, await sr.json());
}
export type JupiterRoute = ReturnType<typeof routeOf>;
