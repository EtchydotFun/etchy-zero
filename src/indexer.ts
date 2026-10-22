import { PublicKey, type Connection } from '@solana/web3.js';
import { base58, le } from './borsh.ts';
import { esplora } from './bitcoin.ts';
import { priceE18, type Reserves } from './math.ts';
import { taprootAddress } from './messages.ts';
import { BTC_USD_ACCOUNT, BTC_USD_FEED, parsePyth } from './solswap.ts';
import {
  accountDiscriminator,
  decodeAccount,
  eventsFromLogs,
  PROGRAM_ID,
} from './program.ts';

/**
 * A pool's public record, from the chain only (anyone can run it; Etchy's
 * API runs the same code):
 *
 * - trades: every buy and sale, from the program's `Trade` events;
 * - candles: price over time (sats per whole Rune; open = the price before
 *   the bucket's first trade, so candles join up);
 * - holders: every pool balance on Solana (Solana wallets and Bitcoin
 *   wallets' balances, shown by their bc1p address), the curve, and Runes on
 *   their way to Bitcoin;
 * - Bitcoin holders: the Runes withdrawn to Bitcoin, by address. They come
 *   from the pool's own records of every coin of its Rune (proven on Solana,
 *   see deposits.rs), so no Rune indexer has to be trusted.
 */
export interface IndexedTrade {
  /** `signature:index` (index: the event's place in its transaction). */
  id: string;
  signature: string;
  slot: number;
  /** Unix seconds (the program's clock). */
  time: number;
  side: 'buy' | 'sell';
  /** The balance owner (a Bitcoin wallet's owner address for bc1p wallets). */
  owner: string;
  signer: string;
  /** WBTC sats the trader paid (buy) or got (sale). */
  btcAmount: bigint;
  runeAmount: bigint;
  fee: { total: bigint; creator: bigint; protocol: bigint };
  priceBeforeE18: bigint;
  /** Sats per whole Rune after the trade, 18 decimals. */
  priceE18: bigint;
  reserves: Reserves;
  /**
   * US dollars per BTC when the trade was indexed live (null: indexed
   * later; shown at today's price).
   */
  btcUsd?: number | null;
}
/** A trade with its pool (live subscriptions, logs). */
export type LiveTrade = IndexedTrade & { pool: string };
export interface PoolIndex {
  version: 1;
  pool: string;
  divisibility: number;
  supply: bigint;
  /** The newest transaction read (resume point). */
  newest: string | null;
  /** Oldest first. */
  trades: IndexedTrade[];
  /** Transactions that could not be read (kept out, logged). */
  skipped: number;
}
export interface PoolIndexStore {
  load(pool: string): Promise<PoolIndex | null>;
  save(index: PoolIndex): Promise<void>;
}
export function memoryIndexStore(): PoolIndexStore {
  const m = new Map<string, string>();
  return {
    load: async (p) => (m.has(p) ? indexFromJson(m.get(p)!) : null),
    save: async (ix) => void m.set(ix.pool, indexToJson(ix)),
  };
}
/** For file or database stores (bigints as strings). */
export const indexToJson = (ix: PoolIndex) =>
  JSON.stringify(ix, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
export const indexFromJson = (s: string) =>
  JSON.parse(s, (_k, v) =>
    typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  ) as PoolIndex;

/** Candle sizes, like pump.fun's chart. */
export const CANDLE_SECONDS = {
  '1s': 1,
  '5s': 5,
  '15s': 15,
  '30s': 30,
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1_800,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
} as const;
export type CandleInterval = keyof typeof CANDLE_SECONDS;
export interface Candle {
  /** Bucket start (unix seconds). */
  time: number;
  /** Sats per whole Rune, 18 decimals. */
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  /** WBTC sats traded (paid by buyers plus got by sellers). */
  volumeSats: bigint;
  trades: number;
}

/** Candles from trades (oldest first). */
export function candlesOf(trades: IndexedTrade[], seconds: number): Candle[] {
  const out: Candle[] = [];
  for (const t of trades) {
    const time = Math.floor(t.time / seconds) * seconds;
    let c = out[out.length - 1];
    if (!c || c.time !== time) {
      c = {
        time,
        open: t.priceBeforeE18,
        high: t.priceBeforeE18,
        low: t.priceBeforeE18,
        close: t.priceBeforeE18,
        volumeSats: 0n,
        trades: 0,
      };
      out.push(c);
    }
    if (t.priceE18 > c.high) c.high = t.priceE18;
    if (t.priceE18 < c.low) c.low = t.priceE18;
    c.close = t.priceE18;
    c.volumeSats += t.btcAmount;
    c.trades++;
  }
  return out;
}

/** A price (18 decimals) as a market cap in sats: price x whole supply. */
export const marketCapSats = (
  priceE18: bigint,
  supply: bigint,
  divisibility: number,
) => (priceE18 * supply) / 10n ** BigInt(divisibility) / 10n ** 18n;
/** The same in BTC, for display (8 decimals and more). */
export const marketCapBtc = (
  priceE18: bigint,
  supply: bigint,
  divisibility: number,
) =>
  Number((priceE18 * supply) / 10n ** BigInt(divisibility) / 10n ** 10n) / 1e16;

/** A market-cap candle for display: BTC or US dollars. */
export interface ValueCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Traded, in the same unit (BTC or USD). */
  volume: number;
  trades: number;
}
/**
 * Market-cap candles in BTC and in US dollars (pump.fun style: each candle
 * opens where the last one closed). A trade's dollars use the BTC price of
 * its time when known, else `btcUsdNow`; no dollars without either.
 */
export function marketCapCandles(
  trades: IndexedTrade[],
  seconds: number,
  supply: bigint,
  divisibility: number,
  btcUsdNow: number | null,
): { btc: ValueCandle[]; usd: ValueCandle[] | null } {
  const mc = (p: bigint) => marketCapBtc(p, supply, divisibility);
  const make = (rate: (t: IndexedTrade) => number | null) => {
    const out: ValueCandle[] = [];
    let prev: number | null = null;
    for (const t of trades) {
      const r = rate(t);
      if (r === null) return null;
      const time = Math.floor(t.time / seconds) * seconds;
      const after = mc(t.priceE18) * r;
      let c = out[out.length - 1];
      if (!c || c.time !== time) {
        const open = prev ?? mc(t.priceBeforeE18) * r;
        c = {
          time,
          open,
          high: open,
          low: open,
          close: open,
          volume: 0,
          trades: 0,
        };
        out.push(c);
      }
      c.high = Math.max(c.high, after);
      c.low = Math.min(c.low, after);
      c.close = after;
      c.volume += (Number(t.btcAmount) / 1e8) * r;
      c.trades++;
      prev = after;
    }
    return out;
  };
  return {
    btc: make(() => 1)!,
    usd: make((t) => t.btcUsd ?? btcUsdNow),
  };
}

/**
 * BTC in US dollars from Pyth's price account on Solana (the one the
 * program uses; mainnet and devnet), cached `maxAgeMs`. Null when unknown
 * or older than an hour.
 */
export function pythBtcUsd(connection: Connection, maxAgeMs = 10_000) {
  let last: { at: number; v: number | null } | null = null;
  return async (): Promise<number | null> => {
    if (last && Date.now() - last.at < maxAgeMs) return last.v;
    let v: number | null = null;
    try {
      const a = await connection.getAccountInfo(BTC_USD_ACCOUNT, 'confirmed');
      if (a) {
        const p = parsePyth(a.data, BTC_USD_FEED);
        if (Date.now() / 1000 - p.publishTime < 3_600)
          v = Number(p.price) * 10 ** p.expo;
      }
    } catch {
      v = last?.v ?? null;
    }
    last = { at: Date.now(), v };
    return v;
  };
}

/**
 * The trades of one transaction from its logs (only the program's own
 * events), as the indexer stores them. `pool`: only that pool's.
 */
export function tradesFromLogs(
  logs: readonly string[],
  signature: string,
  slot: number,
  divisibilityOf: (pool: string) => number | undefined,
  o: { pool?: string; programId?: PublicKey } = {},
): LiveTrade[] {
  const out: LiveTrade[] = [];
  eventsFromLogs(logs, o.programId ?? PROGRAM_ID).forEach((e, i) => {
    if (e.name !== 'Trade') return;
    const d = e.data;
    const pool = key(d.pool);
    if (o.pool && pool !== o.pool) return;
    const div = divisibilityOf(pool);
    if (div === undefined) return;
    const side = d.is_buy ? 'buy' : 'sell';
    const reserves = {
      btcReal: d.btc_real as bigint,
      btcVirtual: d.btc_virtual as bigint,
      rune: d.rune_reserve as bigint,
    };
    const runeAmount = d.rune_amount as bigint;
    out.push({
      pool,
      id: `${signature}:${i}`,
      signature,
      slot,
      time: Number(d.timestamp as bigint),
      side,
      owner: key(d.owner),
      signer: key(d.signer),
      btcAmount: d.btc_amount as bigint,
      runeAmount,
      fee: {
        total: d.fee_total as bigint,
        creator: d.fee_creator as bigint,
        protocol: d.fee_protocol as bigint,
      },
      priceBeforeE18: priceBefore(
        {
          side,
          btcPoolDelta: d.btc_pool_delta as bigint,
          runeAmount,
          reserves,
        },
        div,
      ),
      priceE18: d.price_e18 as bigint,
      reserves,
    });
  });
  return out;
}

/**
 * Every new trade the moment it is confirmed (a WebSocket log
 * subscription; no Etchy server). `pool` narrows to one pool. Returns the
 * unsubscribe function. A trade can come twice after a reconnect: key on
 * `id`.
 */
export function subscribeTrades(
  connection: Connection,
  onTrade: (t: LiveTrade) => void,
  o: { pool?: PublicKey; programId?: PublicKey } = {},
): () => void {
  const programId = o.programId ?? PROGRAM_ID;
  const divs = new Map<string, number | null>();
  const pending = new Map<string, Promise<number | null>>();
  const divisibility = (pool: string) => {
    let p = pending.get(pool);
    if (!p) {
      p = connection
        .getAccountInfo(new PublicKey(pool), 'confirmed')
        .then((a) =>
          a
            ? (decodeAccount<Raw>('Pool', a.data).divisibility as number)
            : null,
        )
        .catch(() => null)
        .then((d) => {
          divs.set(pool, d);
          if (d === null) pending.delete(pool); // try again next time
          return d;
        });
      pending.set(pool, p);
    }
    return p;
  };
  const only = o.pool?.toBase58();
  const id = connection.onLogs(
    o.pool ?? programId,
    (l, ctx) => {
      if (l.err) return;
      // Which pools traded (cheap), then decode with their divisibility.
      const pools = new Set<string>();
      for (const e of eventsFromLogs(l.logs, programId))
        if (e.name === 'Trade') pools.add(key(e.data.pool));
      if (!pools.size) return;
      void Promise.all([...pools].map(divisibility)).then(() => {
        const list = tradesFromLogs(
          l.logs,
          l.signature,
          ctx.slot,
          (p) => divs.get(p) ?? undefined,
          { pool: only, programId },
        );
        for (const t of list) onTrade(t);
      });
    },
    'confirmed',
  );
  return () => void connection.removeOnLogsListener(id).catch(() => {});
}

/** A pool's numbers for coin lists (from its trades). */
export interface PoolStats {
  trades: number;
  volumeSats: bigint;
  trades24h: number;
  buys24h: number;
  sells24h: number;
  volume24hSats: bigint;
  /** In US dollars, each trade at its own BTC price (else today's); null without one. */
  volume24hUsd: number | null;
  /** Price change over 24 hours (%; from the start price for younger pools). */
  change24hPct: number;
  /** Highest price ever (sats per whole Rune, 18 decimals) and when. */
  athPriceE18: bigint;
  athTime: number | null;
  lastTradeTime: number | null;
  /** Distinct traders over 24 hours. */
  traders24h: number;
}
/** Stats at `now` (unix seconds) from trades (oldest first). */
export function poolStats(
  trades: IndexedTrade[],
  now: number,
  btcUsdNow: number | null,
): PoolStats {
  const since = now - 86_400;
  let volumeSats = 0n;
  let v24 = 0n;
  let usd: number | null = 0;
  let buys = 0;
  let sells = 0;
  const traders = new Set<string>();
  let ath = trades.length ? trades[0].priceBeforeE18 : 0n;
  let athTime: number | null = null;
  let before24: bigint | null = null;
  let first24: bigint | null = null;
  for (const t of trades) {
    volumeSats += t.btcAmount;
    if (t.priceE18 > ath) {
      ath = t.priceE18;
      athTime = t.time;
    }
    if (t.time < since) {
      before24 = t.priceE18;
      continue;
    }
    first24 ??= t.priceBeforeE18;
    v24 += t.btcAmount;
    if (t.side === 'buy') buys++;
    else sells++;
    traders.add(t.owner);
    const r = t.btcUsd ?? btcUsdNow;
    usd =
      usd === null || r === null ? null : usd + (Number(t.btcAmount) / 1e8) * r;
  }
  const last = trades.length ? trades[trades.length - 1] : null;
  const from = before24 ?? first24;
  const to = last?.priceE18 ?? null;
  const change =
    from && to && from > 0n
      ? Number(((to - from) * 1_000_000n) / from) / 10_000
      : 0;
  return {
    trades: trades.length,
    volumeSats,
    trades24h: buys + sells,
    buys24h: buys,
    sells24h: sells,
    volume24hSats: v24,
    volume24hUsd: usd,
    change24hPct: change,
    athPriceE18: ath,
    athTime,
    lastTradeTime: last?.time ?? null,
    traders24h: traders.size,
  };
}

/** The price before a trade, from the reserves after it. */
export function priceBefore(
  t: {
    side: 'buy' | 'sell';
    btcPoolDelta: bigint;
    runeAmount: bigint;
    reserves: Reserves;
  },
  divisibility: number,
): bigint {
  const r = t.reserves;
  const before =
    t.side === 'buy'
      ? {
          btcReal: r.btcReal - t.btcPoolDelta,
          btcVirtual: r.btcVirtual,
          rune: r.rune + t.runeAmount,
        }
      : {
          btcReal: r.btcReal + t.btcPoolDelta,
          btcVirtual: r.btcVirtual,
          rune: r.rune - t.runeAmount,
        };
  return priceE18(before, divisibility);
}

export interface PoolHolder {
  /** The balance owner on Solana. */
  owner: string;
  /** Set when the owner is a Bitcoin wallet's balance (its bc1p address). */
  bitcoinAddress: string | null;
  amount: bigint;
}
export interface PoolHolders {
  supply: bigint;
  divisibility: number;
  /** In the curve (not anyone's yet). */
  curve: bigint;
  /** Pool balances, largest first. */
  holders: PoolHolder[];
  /** Asked for withdrawal, not paid on Bitcoin yet. */
  toBitcoin: bigint;
}
export interface BitcoinHolder {
  address: string;
  amount: bigint;
  coins: number;
}
export interface BitcoinHolders {
  /** Largest first. */
  holders: BitcoinHolder[];
  total: bigint;
  coins: number;
}

const WD_PENDING = 0;
const WD_IN_BATCH = 1;
const COIN_FREE = 0;
type Raw = Record<string, unknown>;
const key = (k: unknown) => (k as PublicKey).toBase58();

export function createPoolIndexer(o: {
  connection: Connection;
  store?: PoolIndexStore;
  bitcoin?: ReturnType<typeof esplora>;
  programId?: PublicKey;
  /** BTC in US dollars now (default: Pyth on Solana); stored on trades indexed live. */
  btcUsd?: () => Promise<number | null>;
  log?: (line: string) => void;
}) {
  const conn = o.connection;
  const btcUsd = o.btcUsd ?? pythBtcUsd(o.connection);
  const programId = o.programId ?? PROGRAM_ID;
  const store = o.store ?? memoryIndexStore();
  const bitcoin = o.bitcoin ?? esplora();
  const log = o.log ?? (() => {});
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function rpc<T>(f: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await f();
      } catch (e) {
        const m = String((e as Error).message ?? e);
        if (
          !/429|Too many|fetch failed|ECONNRESET|socket|503|502|timed out/i.test(
            m,
          ) ||
          attempt >= 5
        )
          throw e;
        await sleep(Math.min(20_000, 1_000 * 2 ** attempt));
      }
    }
  }
  const disc = (name: string) => base58(accountDiscriminator(name));
  const indexes = new Map<string, PoolIndex>();
  const syncing = new Map<string, Promise<number>>();

  async function index(pool: PublicKey): Promise<PoolIndex> {
    const k = pool.toBase58();
    let ix = indexes.get(k) ?? (await store.load(k));
    if (!ix) {
      const a = await rpc(() => conn.getAccountInfo(pool, 'confirmed'));
      if (!a) throw new Error('no such pool');
      const p = decodeAccount<Raw>('Pool', a.data);
      ix = {
        version: 1,
        pool: k,
        divisibility: p.divisibility as number,
        supply: p.supply as bigint,
        newest: null,
        trades: [],
        skipped: 0,
      };
    }
    indexes.set(k, ix);
    return ix;
  }

  /** A transaction's trades of this pool (null: not readable yet). */
  async function tradesIn(
    signature: string,
    pool: string,
    divisibility: number,
  ): Promise<IndexedTrade[] | null> {
    const tx = await rpc(() =>
      conn.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      }),
    );
    if (!tx) return null;
    if (tx.meta?.err || !tx.meta?.logMessages) return [];
    return tradesFromLogs(
      tx.meta.logMessages,
      signature,
      tx.slot,
      () => divisibility,
      { pool, programId },
    ).map((t) => {
      const c: Partial<LiveTrade> = { ...t };
      delete c.pool; // the index is per pool
      return c as IndexedTrade;
    });
  }

  /**
   * Reads the pool's new transactions (all of them the first time), oldest
   * first, and saves as it goes: safe to stop and resume. Returns the new
   * trades.
   */
  async function syncPool(pool: PublicKey): Promise<number> {
    const ix = await index(pool);
    const sigs: {
      signature: string;
      err: boolean;
      blockTime: number | null;
    }[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await rpc(() =>
        conn.getSignaturesForAddress(
          pool,
          { until: ix.newest ?? undefined, before, limit: 1000 },
          'confirmed',
        ),
      );
      for (const s of page)
        sigs.push({
          signature: s.signature,
          err: !!s.err,
          blockTime: s.blockTime ?? null,
        });
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    let added = 0;
    let since = 0;
    for (let i = sigs.length - 1; i >= 0; i--) {
      const s = sigs[i];
      if (!s.err) {
        const t = await tradesIn(s.signature, ix.pool, ix.divisibility);
        if (!t) {
          // Not served yet: try again next time, unless it never will be.
          const old =
            s.blockTime !== null && Date.now() / 1000 - s.blockTime > 600;
          if (!old) break;
          ix.skipped++;
          log(
            `${ix.pool.slice(0, 6)}..: transaction ${s.signature} unreadable, skipped`,
          );
        } else {
          // Live (a few minutes old at most): today's BTC price is its price.
          const recent = t.some((x) => Date.now() / 1000 - x.time < 300);
          const usd = recent ? await btcUsd().catch(() => null) : null;
          for (const x of t)
            x.btcUsd = Date.now() / 1000 - x.time < 300 ? usd : null;
          ix.trades.push(...t);
          added += t.length;
        }
      }
      ix.newest = s.signature;
      if (++since >= 25) {
        await store.save(ix);
        since = 0;
      }
    }
    if (sigs.length) await store.save(ix);
    return added;
  }
  /** One sync per pool at a time (callers share it). */
  function sync(pool: PublicKey): Promise<number> {
    const k = pool.toBase58();
    let p = syncing.get(k);
    if (!p) {
      p = syncPool(pool).finally(() => syncing.delete(k));
      syncing.set(k, p);
    }
    return p;
  }

  // Bitcoin wallets' owner addresses never change: remember them.
  const btcOwnerOf = new Map<string, string | null>();
  async function bitcoinAddresses(owners: string[]) {
    const todo = [...new Set(owners)].filter((x) => !btcOwnerOf.has(x));
    for (let i = 0; i < todo.length; i += 100) {
      const part = todo.slice(i, i + 100);
      const infos = await rpc(() =>
        conn.getMultipleAccountsInfo(
          part.map((x) => new PublicKey(x)),
          'confirmed',
        ),
      );
      infos.forEach((a, k) => {
        let addr: string | null = null;
        if (a && a.owner.equals(programId))
          try {
            const b = decodeAccount<Raw>('BtcOwner', a.data);
            addr = taprootAddress(b.bitcoin_key as Uint8Array);
          } catch {
            addr = null;
          }
        btcOwnerOf.set(part[k], addr);
      });
    }
    return (owner: string) => btcOwnerOf.get(owner) ?? null;
  }

  async function trades(
    pool: PublicKey,
    q: { limit?: number; before?: string } = {},
  ) {
    const ix = await index(pool);
    const all = ix.trades;
    let end = all.length;
    if (q.before) {
      const at = all.findIndex((t) => t.id === q.before);
      if (at >= 0) end = at;
    }
    const limit = Math.min(500, Math.max(1, q.limit ?? 50));
    const list = all.slice(Math.max(0, end - limit), end).reverse();
    const btc = await bitcoinAddresses(list.map((t) => t.owner));
    return {
      trades: list.map((t) => ({ ...t, ownerBitcoin: btc(t.owner) })),
      total: all.length,
      /** Pass as `before` for the next (older) page; null at the start. */
      next: end - limit > 0 ? list[list.length - 1].id : null,
    };
  }

  async function candles(
    pool: PublicKey,
    interval: CandleInterval,
    q: { limit?: number } = {},
  ) {
    const seconds = CANDLE_SECONDS[interval];
    if (!seconds)
      throw new Error(`interval: ${Object.keys(CANDLE_SECONDS).join(', ')}`);
    const ix = await index(pool);
    const limit = Math.min(1_000, Math.max(1, q.limit ?? 300));
    const usdNow = await btcUsd().catch(() => null);
    const mc = marketCapCandles(
      ix.trades,
      seconds,
      ix.supply,
      ix.divisibility,
      usdNow,
    );
    return {
      interval,
      seconds,
      divisibility: ix.divisibility,
      supply: ix.supply,
      btcUsd: usdNow,
      candles: candlesOf(ix.trades, seconds).slice(-limit),
      /** Market cap in BTC. */
      btc: mc.btc.slice(-limit),
      /** Market cap in US dollars (null: no BTC price). */
      usd: mc.usd?.slice(-limit) ?? null,
    };
  }

  async function holders(pool: PublicKey): Promise<PoolHolders> {
    const ix = await index(pool);
    const p58 = pool.toBase58();
    const [balances, withdrawals, pa] = await Promise.all([
      rpc(() =>
        conn.getProgramAccounts(programId, {
          commitment: 'confirmed',
          filters: [
            { memcmp: { offset: 0, bytes: disc('RuneBalance') } },
            { memcmp: { offset: 10, bytes: p58 } },
          ],
        }),
      ),
      rpc(() =>
        conn.getProgramAccounts(programId, {
          commitment: 'confirmed',
          filters: [
            { memcmp: { offset: 0, bytes: disc('Withdrawal') } },
            { memcmp: { offset: 10, bytes: p58 } },
          ],
        }),
      ),
      rpc(() => conn.getAccountInfo(pool, 'confirmed')),
    ]);
    if (!pa) throw new Error('no such pool');
    const list = balances
      .map((x) => decodeAccount<Raw>('RuneBalance', x.account.data))
      .filter((b) => (b.amount as bigint) > 0n)
      .map((b) => ({ owner: key(b.owner), amount: b.amount as bigint }))
      .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
    const btc = await bitcoinAddresses(list.map((h) => h.owner));
    let toBitcoin = 0n;
    for (const w of withdrawals) {
      const d = decodeAccount<Raw>('Withdrawal', w.account.data);
      if (d.status === WD_PENDING || d.status === WD_IN_BATCH)
        toBitcoin += d.amount as bigint;
    }
    return {
      supply: ix.supply,
      divisibility: ix.divisibility,
      curve: decodeAccount<Raw>('Pool', pa.data).rune_reserve as bigint,
      holders: list.map((h) => ({ ...h, bitcoinAddress: btc(h.owner) })),
      toBitcoin,
    };
  }

  // Confirmed Bitcoin transactions never change: their outputs' addresses.
  const outputsOf = new Map<string, string[]>();
  async function bitcoinHolders(pool: PublicKey): Promise<BitcoinHolders> {
    const coins = await rpc(() =>
      conn.getProgramAccounts(programId, {
        commitment: 'confirmed',
        filters: [
          { memcmp: { offset: 0, bytes: disc('KnownCoin') } },
          { memcmp: { offset: 10, bytes: pool.toBase58() } },
          { memcmp: { offset: 98, bytes: base58(le(COIN_FREE, 1)) } },
        ],
      }),
    );
    const by = new Map<string, BitcoinHolder>();
    let total = 0n;
    for (const x of coins) {
      const c = decodeAccount<Raw>('KnownCoin', x.account.data);
      const txid = Array.from(c.txid as Uint8Array)
        .reverse()
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      let outs = outputsOf.get(txid);
      if (!outs) {
        const tx = (await bitcoin.get(`/tx/${txid}`)) as {
          vout: { scriptpubkey: string; scriptpubkey_address?: string }[];
        } | null;
        if (!tx) continue;
        outs = tx.vout.map((v) => v.scriptpubkey_address ?? v.scriptpubkey);
        outputsOf.set(txid, outs);
      }
      const address = outs[c.vout as number] ?? `${txid}:${c.vout}`;
      const h = by.get(address) ?? { address, amount: 0n, coins: 0 };
      h.amount += c.runes as bigint;
      h.coins++;
      by.set(address, h);
      total += c.runes as bigint;
    }
    return {
      holders: [...by.values()].sort((a, b) =>
        a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0,
      ),
      total,
      coins: coins.length,
    };
  }

  /** Numbers for coin lists: 24h volume and change, ATH, last trade (from the index). */
  async function stats(pool: PublicKey): Promise<PoolStats> {
    const ix = await index(pool);
    return poolStats(
      ix.trades,
      Math.floor(Date.now() / 1000),
      await btcUsd().catch(() => null),
    );
  }
  /** How many owners hold some of the pool's Runes in a pool balance (reads amounts only). */
  async function holderCount(pool: PublicKey): Promise<number> {
    const list = await rpc(() =>
      conn.getProgramAccounts(programId, {
        commitment: 'confirmed',
        // RuneBalance: disc 8, version, bump, pool @10, owner @42, amount u128 @74.
        dataSlice: { offset: 74, length: 16 },
        filters: [
          { memcmp: { offset: 0, bytes: disc('RuneBalance') } },
          { memcmp: { offset: 10, bytes: pool.toBase58() } },
        ],
      }),
    );
    return list.filter((x) => x.account.data.some((b) => b !== 0)).length;
  }

  /**
   * Live: every trade of the program the moment it is confirmed (WebSocket
   * logs), with the BTC price of that moment, then the pool's index catches
   * up in the background. Returns the unsubscribe function.
   */
  function live(
    onTrade: (t: LiveTrade & { ownerBitcoin: string | null }) => void,
  ) {
    return subscribeTrades(
      conn,
      (t) => {
        void Promise.all([
          btcUsd().catch(() => null),
          bitcoinAddresses([t.owner]).catch(() => () => null),
        ]).then(([usd, btc]) => {
          onTrade({ ...t, btcUsd: usd, ownerBitcoin: btc(t.owner) });
          void sync(new PublicKey(t.pool)).catch(() => 0);
        });
      },
      { programId },
    );
  }

  return {
    sync,
    trades,
    candles,
    holders,
    bitcoinHolders,
    btcUsd,
    stats,
    holderCount,
    live,
  };
}
export type PoolIndexer = ReturnType<typeof createPoolIndexer>;
