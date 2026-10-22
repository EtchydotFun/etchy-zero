/**
 * A client of Etchy's public pool API: pool lists, trades, quotes and
 * balances (read), and the relay that sends Bitcoin wallets' signed orders
 * and pays their Solana fees (what etchy.fun uses). Any platform may use
 * it; everything it sends is checked by the program itself.
 */
export interface ApiPool {
  pool: string;
  runeId: string;
  name: string;
  symbol: string | null;
  divisibility: number;
  supply: string;
  active: boolean;
  paused: boolean;
  btcReal: string;
  btcVirtual: string;
  runeReserve: string;
  priceE18: string;
  /** Sats per whole Rune (for display). */
  priceSats: number;
  marketCapSats: number;
  marketCapBtc: number;
  /** Null when the BTC price is unknown. */
  marketCapUsd: number | null;
  mode: number;
  fees: {
    buyBps: number;
    buyCreatorBps: number;
    sellBps: number;
    sellCreatorBps: number;
  };
  trades: string;
  volumeBtc: string;
  vaultAddress: string | null;
  /** Unix seconds. */
  createdAt: number;
  /** Coin-list numbers (null while the pool's trades are being read). */
  stats: ApiPoolStats | null;
}
export interface ApiPoolStats {
  holders: number;
  trades24h: number;
  buys24h: number;
  sells24h: number;
  traders24h: number;
  volume24hSats: string;
  volume24hUsd: number | null;
  change24hPct: number;
  athMarketCapBtc: number;
  athMarketCapUsd: number | null;
  athTime: number | null;
  lastTradeTime: number | null;
}
/** Sort orders of `pools()`. */
export type ApiPoolSort =
  'new' | 'mcap' | 'volume' | 'change' | 'trades' | 'last';
/** A live trade (the stream): an `ApiTrade` with its pool. */
export type ApiLiveTrade = ApiTrade & { pool: string };
export interface ApiTrade {
  /** `signature:index`: pass as `before` for older trades. */
  id: string;
  signature: string;
  time: number | null;
  side: 'buy' | 'sell';
  owner: string;
  /** The trader's bc1p address when a Bitcoin wallet traded. */
  ownerBitcoin: string | null;
  btcAmount: string;
  runeAmount: string;
  fee: { total: string; creator: string; protocol: string };
  priceBeforeE18: string;
  priceE18: string;
  /** US dollars per BTC at the trade's time (null: use today's, `btcUsd` of the page). */
  btcUsd: number | null;
}
/** A market-cap candle in BTC or US dollars. */
export interface ApiValueCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}
export interface ApiCandle {
  time: number;
  /** Sats per whole Rune, 18 decimals. */
  open: string;
  high: string;
  low: string;
  close: string;
  volumeSats: string;
  trades: number;
}
export interface ApiHolders {
  supply: string;
  divisibility: number;
  /** In the curve (not anyone's yet). */
  curve: string;
  /** Asked for withdrawal, not paid on Bitcoin yet. */
  toBitcoin: string;
  /** Runes on Bitcoin (withdrawn), per the pool's proven records. */
  onBitcoin: string;
  holders: { owner: string; bitcoinAddress: string | null; amount: string }[];
}
export interface ApiBitcoinHolders {
  total: string;
  coins: number;
  holders: { address: string; amount: string; coins: number }[];
}
export interface ApiQuote {
  side: 'buy' | 'sell';
  amountIn: string;
  amountOut: string;
  minOut: string;
  fee: { total: string; creator: string; protocol: string };
  impactBps: number;
}
export interface ApiOrder {
  /** What the Bitcoin wallet signs (BIP-322 "sign message"). */
  text: string;
  nonce: string;
  expiry: string;
}

export class EtchyApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function createEtchyApi(baseUrl: string, f: typeof fetch = fetch) {
  const base = baseUrl.replace(/\/+$/, '');
  async function call<T>(path: string, body?: unknown): Promise<T> {
    const r = await f(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body:
        body === undefined
          ? undefined
          : JSON.stringify(body, (_k, v) =>
              typeof v === 'bigint' ? v.toString() : v,
            ),
    });
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) throw new EtchyApiError(j.error ?? `HTTP ${r.status}`, r.status);
    return j as T;
  }
  /**
   * Live trades (Server-Sent Events over fetch: browsers and Node 18+).
   * Reconnects by itself; `close()` stops it. A trade may come twice
   * around a reconnect: key on `id`.
   */
  function stream(
    onTrade: (t: ApiLiveTrade) => void,
    o: { pool?: string; onError?: (e: unknown) => void } = {},
  ) {
    let stopped = false;
    let ctrl: AbortController | null = null;
    const run = async () => {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          const r = await f(
            `${base}/v1/stream${o.pool ? `?pool=${o.pool}` : ''}`,
            { signal: ctrl.signal, headers: { accept: 'text/event-stream' } },
          );
          if (!r.ok || !r.body)
            throw new EtchyApiError(`HTTP ${r.status}`, r.status);
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let at: number;
            while ((at = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, at);
              buf = buf.slice(at + 2);
              const event = /^event: (.+)$/m.exec(block)?.[1];
              const data = block
                .split('\n')
                .filter((l) => l.startsWith('data: '))
                .map((l) => l.slice(6))
                .join('\n');
              if (event === 'trade' && data)
                try {
                  onTrade(JSON.parse(data) as ApiLiveTrade);
                } catch (e) {
                  o.onError?.(e);
                }
            }
          }
        } catch (e) {
          if (stopped) return;
          o.onError?.(e);
        }
        if (!stopped) await new Promise((res) => setTimeout(res, 3_000));
      }
    };
    void run();
    return {
      close() {
        stopped = true;
        ctrl?.abort();
      },
    };
  }
  return {
    /** Every pool, with its coin-list numbers; `sort` biggest first (`new`: newest first). */
    pools: (o: { sort?: ApiPoolSort } = {}) =>
      call<{ pools: ApiPool[] }>(
        `/v1/pools${o.sort ? `?sort=${o.sort}` : ''}`,
      ).then((x) => x.pools),
    pool: (pool: string) => call<ApiPool>(`/v1/pools/${pool}`),
    /** 24h volume and change, holders, all-time high. */
    stats: (pool: string) => call<ApiPoolStats>(`/v1/pools/${pool}/stats`),
    stream,
    trades: (pool: string, limit = 50) =>
      call<{ trades: ApiTrade[] }>(
        `/v1/pools/${pool}/trades?limit=${limit}`,
      ).then((x) => x.trades),
    /** Newest first; `before`: the last trade's `id` of the previous page. */
    tradesPage: (pool: string, o: { limit?: number; before?: string } = {}) =>
      call<{
        trades: ApiTrade[];
        total: number;
        next: string | null;
        btcUsd: number | null;
      }>(
        `/v1/pools/${pool}/trades?limit=${o.limit ?? 50}${o.before ? `&before=${encodeURIComponent(o.before)}` : ''}`,
      ),
    /**
     * Market-cap candles in BTC and US dollars (`usd` null: no BTC price),
     * plus the price candles. `interval`: 1s, 5s, 15s, 30s, 1m, 5m, 15m,
     * 30m, 1h, 4h or 1d.
     */
    candles: (pool: string, interval = '5m', limit = 300) =>
      call<{
        interval: string;
        seconds: number;
        supply: string;
        divisibility: number;
        btcUsd: number | null;
        now: { marketCapBtc: number; marketCapUsd: number | null };
        btc: ApiValueCandle[];
        usd: ApiValueCandle[] | null;
        candles: ApiCandle[];
      }>(`/v1/pools/${pool}/candles?interval=${interval}&limit=${limit}`),
    /** Pool balances on Solana (largest first), the curve, Runes on their way to Bitcoin. */
    holders: (pool: string) => call<ApiHolders>(`/v1/pools/${pool}/holders`),
    /** Who holds the Rune on Bitcoin (withdrawn), by address. */
    bitcoinHolders: (pool: string) =>
      call<ApiBitcoinHolders>(`/v1/pools/${pool}/bitcoin-holders`),
    quote: (
      pool: string,
      side: 'buy' | 'sell',
      amount: bigint,
      slippageBps = 100,
    ) =>
      call<ApiQuote>(
        `/v1/pools/${pool}/quote?side=${side}&amount=${amount}&slippageBps=${slippageBps}`,
      ),
    /** `wallet`: a Solana address or a Bitcoin (bc1p) address. */
    balances: (wallet: string) =>
      call<{
        owner: string;
        balances: { pool: string; name: string; amount: string }[];
        wbtc: string | null;
      }>(`/v1/wallets/${wallet}/balances`),
    /** The order text for a Bitcoin wallet's buy (`amount` sats) or sale (`amount` Rune units). */
    order: (o: {
      pool: string;
      bitcoinAddress: string;
      side: 'buy' | 'sell';
      amount: bigint;
      minOut: bigint;
    }) => call<ApiOrder>('/v1/relay/order', o),
    /** The signed order: Etchy's relay sends it (pays the Solana fee). */
    trade: (o: {
      pool: string;
      bitcoinAddress: string;
      side: 'buy' | 'sell';
      amount: bigint;
      minOut: bigint;
      nonce: string | bigint;
      expiry: string | bigint;
      /** The wallet's BIP-322 signature (base64, as wallets return it). */
      signature: string;
    }) => call<{ signature: string }>('/v1/relay/trade', o),
    /**
     * Add BTC through NEAR: the wallet's SOL deposit address (ask NEAR for
     * a BTC -> SOL quote paying it: `nearAddQuote`) and what swapping the
     * SOL there into WBTC gives now.
     */
    nearAdd: (bitcoinAddress: string) =>
      call<{
        depositSol: string;
        lamports: string;
        ready: boolean;
        minOut: string;
        valueSats: string;
        minDepositSats: string;
        swapFeeLamports: string;
        toleranceBps: number;
        wbtcAccount: string;
      }>(`/v1/wallets/${bitcoinAddress}/near`),
    /** After paying NEAR: Etchy's keeper watches the deposit and swaps it. */
    watchNearAdd: (bitcoinAddress: string) =>
      call<{ watching: boolean; depositSol: string }>('/v1/sol-swap/watch', {
        bitcoinAddress,
      }),
    /**
     * Withdraw to Bitcoin through NEAR, step 1: the relay's quote and the
     * text the wallet signs (`amount` sats of WBTC to the Bitcoin address `to`).
     */
    nearWithdrawOrder: (o: {
      bitcoinAddress: string;
      amount: bigint;
      to: string;
    }) =>
      call<{
        id: string;
        text: string;
        to: string;
        amount: string;
        /** SOL passed to NEAR's deposit address. */
        minLamports: string;
        deposit: string;
        /** Sats NEAR expects to pay to `to`, and at least. */
        btcOut: string;
        btcOutMin: string;
        deadline: string;
        timeEstimateSecs: number | null;
        /** Devnet: a stand-in for NEAR (no BTC arrives). */
        simulated: boolean;
        nonce: string;
        expiry: string;
      }>('/v1/relay/near-withdraw-order', o),
    /** Step 2: the wallet's signature of that text; Etchy's relay sends it. */
    nearWithdraw: (o: { id: string; signature: string }) =>
      call<{ signature: string }>('/v1/relay/near-withdraw', o),
  };
}
export type EtchyApi = ReturnType<typeof createEtchyApi>;
