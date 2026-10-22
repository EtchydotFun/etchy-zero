/**
 * A client of Etchy's public pool API: pool lists, trades, quotes and
 * balances (read), and the relay that sends Bitcoin wallets' signed orders
 * and pays their Solana fees (what etchy.fun uses). Any platform may use
 * it; everything it sends is checked by the program itself.
 */
export interface ApiPool {
  pool: string;
  runeId: string;
  /** The Rune's name with its spacers, e.g. ETCHY•FUN (`name` is the same). */
  runeName: string;
  name: string;
  /** The Rune's one-character currency symbol. */
  symbol: string | null;
  /** What the Rune's etching inscribed (null while the API reads it). */
  meta: ApiPoolMeta | null;
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
  /** Numbers for Rune lists (null while the pool's trades are being read). */
  stats: ApiPoolStats | null;
}
/** A Rune's inscribed launch details (see `runeInscription`); null fields: not inscribed. */
export interface ApiPoolMeta {
  /** `<etching txid>i0`; null: the etching inscribed nothing. */
  inscriptionId: string | null;
  name: string | null;
  ticker: string | null;
  description: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  image: string | null;
  solanaMint: string | null;
  /** Who gets the creator part of the fees (inscribed): its holders, or Bitcoin addresses. */
  fees: 'HOLDERS' | 'ROUTED' | null;
  /** ROUTED: the Bitcoin addresses and their shares (basis points, adding up to 10,000). */
  feeRoute: ApiFeeRouteEntry[] | null;
  /** The wallet that launched the Rune (inscribed), and what it paid with. */
  deployer: string | null;
  paidWith: 'BTC' | 'SOL' | null;
  /** Path of the inscribed logo on the API (null: no image to show). */
  logo: string | null;
}
export interface ApiFeeRouteEntry {
  address: string;
  bps: number;
}
/** One holder's part of a pool's fee rewards (sats). */
export interface ApiRewardEntry {
  /** A Bitcoin address (held on Bitcoin) or a pool balance owner (Solana address). */
  address: string;
  sats: string;
  side: 'bitcoin' | 'pool';
  /** A pool balance of a Bitcoin wallet: its bc1p address. */
  bitcoinAddress: string | null;
}
/**
 * A pool's fee rewards: the creator part of every trade goes to the Rune's
 * holders (half to those holding it on Bitcoin, half to those holding it in
 * the pool, by time held) or to the inscribed Bitcoin addresses.
 * `fees: null`: this pool has no fee rewards.
 */
export interface ApiRewards {
  pool: string;
  fees: 'holders' | 'routed' | null;
  route?: ApiFeeRouteEntry[] | null;
  /** The Bitcoin holders' part (5,000 = half; the rest: pool holders). */
  bitcoinShareBps?: number;
  /** Each side's part not shared out yet (sats). */
  waiting?: { bitcoin: string; pool: string };
  /** Holders counted on each side. */
  holders?: { bitcoin: number; pool: number };
  unclaimedSats?: string;
  owedSats?: string;
  paidSats?: string;
  allocatedSats?: string;
  /** Largest first, at most 50 each. */
  owed?: ApiRewardEntry[];
  paid?: ApiRewardEntry[];
  lastRoundAt?: string | null;
  nextRoundAt?: string;
}
/** A withdrawal of Runes to Bitcoin. */
export interface ApiWithdrawal {
  pool: string;
  id: string;
  amount: string;
  fee: string;
  /** The Bitcoin address it pays. */
  to: string;
  status: string;
  /** The Bitcoin transaction that paid it (once paid). */
  txid: string | null;
  vout: number | null;
  requestedAt: number;
}
/** A deposit (Runes sent back to the vault) and where it is. */
export interface ApiDeposit {
  pool: string;
  txid: string;
  seen: boolean;
  confirmations: number;
  /** Confirmations needed before it is credited. */
  need: number;
  state: string;
  runes: string | null;
  owner: string | null;
}
/** A deposit to sign: one Bitcoin transaction (PSBT). */
export interface ApiDepositPlan {
  pool: string;
  psbtBase64: string;
  /** For the wallet's signPsbt: which inputs each address signs. */
  signInputs: Record<string, number[]>;
  unsignedTxid: string;
  runes: string;
  coins: number;
  vaultAddress: string;
  minerFeeSats: string;
  changeSats: string;
  vsize: number;
  feeRate: number;
}
/** A trade paid or paid out in SOL (`lamports`), through the pool's WBTC. */
export interface ApiSolQuote {
  side: 'buy' | 'sell';
  lamports: string;
  feeSats: string;
  impactBps: number;
  /** WBTC the wallet still had from earlier sales: added to this trade. */
  leftoverSats: string;
  /** Buy: the sats the SOL pays for, the Runes out and at least. */
  sats?: string;
  runeOut?: string;
  minRuneOut?: string;
  /** Sale: the Runes in, the sats they give and at least, the SOL expected. */
  runeIn?: string;
  btcOut?: string;
  minBtcOut?: string;
  lamportsExpected?: string;
}
/** The step 1 answer of `runesOutOrder`: the approval text the wallet signs. */
export interface ApiRunesOutOrder {
  id: string;
  text: string;
  pool: string;
  /** The wallet's own Taproot address (the only place it can go). */
  to: string;
  amount: string;
  /** Runes sold for the Bitcoin withdrawal fee, and that fee in sats. */
  feeRunes: string;
  feeSats: string;
  expiry: string;
}
/** A one-time Solana key (Ed25519): its address and a signer of raw bytes. */
export interface SessionKey {
  publicKey: string;
  sign: (message: Uint8Array) => Promise<Uint8Array>;
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

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes: Uint8Array) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
}
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/**
 * A one-time Solana key made with Web Crypto (Ed25519: browsers, Node 20+).
 * Its private key cannot be exported and is gone with the page or process.
 */
export async function oneTimeSessionKey(): Promise<SessionKey> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new EtchyApiError('NO_WEB_CRYPTO', 0);
  const pair = (await subtle.generateKey({ name: 'Ed25519' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  if (pub.length !== 32) throw new EtchyApiError('NO_ED25519', 0);
  return {
    publicKey: b58(pub),
    sign: async (message) =>
      new Uint8Array(
        await subtle.sign(
          { name: 'Ed25519' },
          pair.privateKey,
          new Uint8Array(message),
        ),
      ),
  };
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
    /**
     * Every pool, with its numbers for Rune lists; `sort` biggest first
     * (`new`: newest first); `q`: a Rune ID, Rune name, ticker or name.
     */
    pools: (o: { sort?: ApiPoolSort; q?: string } = {}) => {
      const p = new URLSearchParams();
      if (o.sort) p.set('sort', o.sort);
      if (o.q) p.set('q', o.q);
      const qs = p.toString();
      return call<{ pools: ApiPool[] }>(`/v1/pools${qs ? `?${qs}` : ''}`).then(
        (x) => x.pools,
      );
    },
    /** A pool by its address, its Rune ID (`971505:1052`) or its Rune name (`ETCHY•FUN`). */
    pool: (pool: string) =>
      call<ApiPool>(`/v1/pools/${encodeURIComponent(pool)}`),
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
    /** The pool's fee rewards: who gets them, owed, paid, waiting, the next round. */
    rewards: (pool: string) => call<ApiRewards>(`/v1/pools/${pool}/rewards`),
    /** The full URL of an API path (for example a pool's `meta.logo`). */
    url: (path: string) => `${base}${path.startsWith('/') ? '' : '/'}${path}`,
    /** A wallet's withdrawals to Bitcoin (a Solana or bc1p address), newest first. */
    withdrawals: (wallet: string, pool?: string) =>
      call<{ withdrawals: ApiWithdrawal[] }>(
        `/v1/wallets/${wallet}/withdrawals${pool ? `?pool=${encodeURIComponent(pool)}` : ''}`,
      ).then((x) => x.withdrawals),
    /** What a withdrawal to Bitcoin costs: sats, and the Runes sold to pay them. */
    withdrawFee: (pool: string) =>
      call<{ feeSats: string; feeRunes: string }>(
        `/v1/pools/${pool}/withdraw-fee`,
      ),
    /**
     * Runes out to a Bitcoin wallet's own Taproot address, step 1: the
     * approval the wallet signs, for a one-time `session` key (its Solana
     * address). Valid 10 minutes. Easier: `withdrawRunes`.
     */
    runesOutOrder: (o: {
      pool: string;
      bitcoinAddress: string;
      amount: bigint;
      session: string;
    }) => call<ApiRunesOutOrder>('/v1/relay/withdraw-runes-order', o),
    /** Step 2: the wallet's signature; returns the session key's message to sign. */
    runesOut: (o: { id: string; signature: string }) =>
      call<{ id: string; message: string; expiresAt: number }>(
        '/v1/relay/withdraw-runes',
        o,
      ),
    /** Step 3: the session key's Ed25519 signature (base64); the relay sends it. */
    sessionSubmit: (o: { id: string; signature: string }) =>
      call<{ signature: string }>('/v1/relay/session-submit', o),
    /** The Rune outputs at a Bitcoin address each pool knows (only those can be deposited). */
    depositCoins: (bitcoinAddress: string) =>
      call<{
        address: string;
        coins: {
          pool: string;
          name: string;
          divisibility: number;
          coins: number;
          runes: string;
        }[];
      }>(`/v1/wallets/${bitcoinAddress}/deposit-coins`),
    /**
     * Runes back into the vault: the PSBT the wallet signs (its Taproot
     * Runes address and a separate BTC address for the fee). Credited to the
     * wallet's pool balance after the confirmations.
     */
    prepareDeposit: (o: {
      pool: string;
      ordinalsAddress: string;
      ordinalsPublicKey: string;
      paymentAddress: string;
      paymentPublicKey: string;
    }) => call<ApiDepositPlan>('/v1/deposits/prepare', o),
    /** The signed PSBT (within 30 minutes): sent on Bitcoin. */
    sendDeposit: (o: { unsignedTxid: string; signedPsbt: string }) =>
      call<{ pool: string; txid: string }>('/v1/deposits/send', o),
    /** Where a deposit is: confirmations, then proven and credited. */
    deposit: (pool: string, txid: string) =>
      call<ApiDeposit>(`/v1/pools/${pool}/deposits/${txid}`),
    /**
     * Trade with SOL from a Solana wallet: a buy spends `amount` lamports, a
     * sale sells `amount` Rune units for SOL. Devnet now (mainnet:
     * `SOL_TRADES_SOON`).
     */
    solQuote: (
      pool: string,
      side: 'buy' | 'sell',
      amount: bigint,
      o: { wallet?: string; slippageBps?: number } = {},
    ) =>
      call<ApiSolQuote>(
        `/v1/pools/${pool}/sol-quote?side=${side}&amount=${amount}&slippageBps=${o.slippageBps ?? 100}${o.wallet ? `&wallet=${o.wallet}` : ''}`,
      ),
    /** The unsigned transaction (base64, the wallet pays its fee); valid `validSeconds`. */
    solOrder: (o: {
      pool: string;
      wallet: string;
      side: 'buy' | 'sell';
      amount: bigint;
      slippageBps?: number;
    }) =>
      call<ApiSolQuote & { transaction: string; validSeconds: number }>(
        '/v1/sol/order',
        o,
      ),
    /** The wallet-signed transaction (base64): co-signed once and sent. */
    solSend: (transaction: string) =>
      call<{ signature: string }>('/v1/sol/send', { transaction }),
    /**
     * Runes out to the wallet's own Bitcoin address, all three steps: the
     * wallet signs ONE message (`signMessage`: BIP-322, base64, as wallets
     * return it). The approval covers exactly `amount` plus the Runes sold
     * for the withdrawal fee, so the one-time key can do nothing after.
     */
    async withdrawRunes(o: {
      pool: string;
      bitcoinAddress: string;
      amount: bigint;
      signMessage: (text: string) => Promise<string>;
      session?: SessionKey;
    }) {
      const key = o.session ?? (await oneTimeSessionKey());
      const order = await call<ApiRunesOutOrder>(
        '/v1/relay/withdraw-runes-order',
        {
          pool: o.pool,
          bitcoinAddress: o.bitcoinAddress,
          amount: o.amount,
          session: key.publicKey,
        },
      );
      const signature = await o.signMessage(order.text);
      const prepared = await call<{ id: string; message: string }>(
        '/v1/relay/withdraw-runes',
        { id: order.id, signature },
      );
      const sig = await key.sign(fromB64(prepared.message));
      const sent = await call<{ signature: string }>(
        '/v1/relay/session-submit',
        { id: prepared.id, signature: toB64(sig) },
      );
      return { ...sent, order };
    },
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
