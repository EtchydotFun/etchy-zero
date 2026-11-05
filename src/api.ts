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
  /** It trades (proven, or early). */
  active: boolean;
  /** Bitcoin's proof is in: Runes go out to Bitcoin and come back. */
  proven: boolean;
  /** Trading before the proof; buys stop at `earlyUntil` (unix seconds) unless proven by then. */
  early: boolean;
  earlyUntil: number | null;
  paused: boolean;
  /** Its creator fees follow its own route (`feeRoute`): anyone pays them out. */
  feeRouted?: boolean;
  /** Its first trade is kept for its creator until `until` (unix seconds): nobody trades before. */
  firstBuy?: { sats: string; until: number } | null;
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
  /** A Mined Rune's mine in brief (null: not a Mined Rune); `mine(pool)` has the rest. */
  mined?: ApiPoolMined | null;
}
export interface ApiPoolMined {
  mine: string;
  start: number;
  roundSecs: number;
  /** Rune units: the whole mine, and mined so far; `speed` per round now. */
  cap: string;
  mined: string;
  speed: string;
  results: string;
  /** About how many miners are mining now. */
  minersNow: number;
  /** Rune units bought back with the mining fees, locked for good. */
  locked: string;
  mcapAvg: string;
  steps: { mcap: string; runesPerRound: string }[];
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
  /** Who gets the creator part of the fees (inscribed): its holders, chosen wallets, or its creator. */
  fees: 'HOLDERS' | 'ROUTED' | 'CREATOR' | null;
  /** ROUTED / CREATOR: the wallets and their shares at launch (basis points, adding up to 10,000). */
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
/**
 * Where a pool's creator fees go now (its own route on Solana; Etchy may
 * hand it over, a CTO). Anyone pays them out: `claimFees`, or the SDK's
 * `claimRouteFees` with any wallet.
 */
export interface ApiFeeRoute {
  pool: string;
  feeRouted: boolean;
  unclaimedSats: string;
  route: {
    /** owner: a Solana wallet, or a Bitcoin wallet's owner (then its bc1p). */
    entries: { owner: string; bps: number; bitcoinAddress: string | null }[];
    paidSats: string;
  } | null;
  firstBuy: { sats: string; buyer: string; until: number } | null;
  /** Etchy pays it out every 10 minutes from this much. */
  autoClaimMinSats: string;
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

// ---------------------------------------------------------------- Ordinals collections
/** One file of a Rune's Ordinals collection (its hash is in the inscribed fingerprint). */
export interface ApiCollectionFile {
  index: number;
  contentType: string;
  bytes: number;
  sha256: string;
  hash: string;
}
/**
 * A pool's Ordinals collection. Each Ordinal is minted by burning `unit`
 * Rune units; a Bitcoin block picks which one. `chain.states`: one digit
 * per Ordinal (0 not minted, 3 minting, 2 minted, 4 in the pool, 5 leaving
 * the pool, 6 on its way to the pool, 7 gone).
 */
export interface ApiCollection {
  id: string;
  size: number;
  /** The fingerprint (Merkle root of every file), inscribed with the Rune's logo. */
  root: string | null;
  pool: string | null;
  pictures: ApiCollectionFile[];
  chain: {
    size: number;
    unit: string;
    free: number;
    drawing: number;
    sending: number;
    out: number;
    drawDelay: number;
    drawConfirmations: number;
    states: string;
  } | null;
}
/** An Ordinal in the pool, on its way to it, or leaving it. */
export interface ApiShelfItem {
  /** Its place in the collection (from 0: Ordinal #item+1). */
  item: number;
  state: 'selling' | 'shelf' | 'leaving' | 'stuck' | 'lost' | 'held';
  /** On its way to the pool: the lowest price its seller takes (sats). */
  minSats: string;
  /** Its seller (on its way to the pool) or buyer (leaving): a Solana address. */
  party: string | null;
  /** Leaving: the Bitcoin address it goes to. */
  to: string | null;
  /** Where it is on Bitcoin. */
  txid: string;
  vout: number;
}
/**
 * The pool's own market for its Ordinals: it buys any minted Ordinal of
 * the collection at its Runes' value at the market price, less `feeBps`,
 * and sells the ones it holds (`state: 'shelf'`) at their Runes' price.
 */
export interface ApiShelf {
  pool: string;
  /** The pool buys and sells Ordinals now. */
  open: boolean;
  /** The pool's Bitcoin address for its Ordinals. */
  address: string | null;
  feeBps: number;
  /** Rune units in one Ordinal. */
  unit: string;
  /** The Bitcoin output an Ordinal travels on to and from the pool (sats). */
  coinSats: string;
  /** What the pool pays for one now, its fee taken (null: it cannot now). */
  sellSats: string | null;
  /** What one from the pool costs now, the buy fee included (null: none to sell). */
  buySats: string | null;
  runeValueSats: string | null;
  /** Bitcoin confirmations before the pool pays a seller. */
  need: number;
  onShelf: number;
  selling: number;
  leaving: number;
  lost: number;
  items: ApiShelfItem[];
  usdPerBtc: number | null;
}
/** One of a Bitcoin wallet's sales to the pool. */
export interface ApiShelfSale {
  item: number;
  txid: string;
  at: number;
  stage:
    | 'unseen'
    | 'confirming'
    | 'proving'
    | 'arrived'
    | 'waiting'
    | 'paid'
    | 'returning'
    | 'returned';
  confirmations: number;
  need: number;
  minSats: string;
  quoteSats: string;
  paidSats: string | null;
  /** Waiting below its lowest price: what the pool pays now. */
  nowSats: string | null;
}
/** A moment of an Ordinal's life, as the program recorded it. */
export interface ApiOrdinalEvent {
  kind:
    | 'minted'
    | 'inscribed'
    | 'moved'
    | 'to-shelf'
    | 'sent-back'
    | 'stuck'
    | 'sold-to-pool'
    | 'bought-from-pool'
    | 'taken-back'
    | 'lost';
  /** Unix seconds (null: not known yet). */
  at: number | null;
  /** The Solana transaction that recorded it. */
  signature: string;
  /** Its Bitcoin transaction, where there is one. */
  txid: string | null;
  to: string | null;
  sats: string | null;
  who: string | null;
}
/** A sale to the pool, ready for the wallet to sign (one Bitcoin transaction). */
export interface ApiShelfSellPlan {
  pool: string;
  item: number;
  unsignedTxid: string;
  psbtBase64: string;
  /** Which inputs each address signs. */
  signInputs: { address: string; indexes: number[] }[];
  shelfAddress: string;
  /** What the pool pays now, and how it is made (gross - kept). */
  quoteSats: string;
  grossSats: string;
  keptSats: string;
  /** The lowest the seller takes; below it the Ordinal waits as the seller's. */
  minSats: string;
  feeBps: number;
  coinSats: string;
  /** From the payment address: the output's top-up plus the network fee. */
  topUpSats: string;
  minerFeeSats: string;
  feeRate: number;
  need: number;
}
/** What a wallet does at the pool's market for Ordinals (`rune_pool::SHELF_*`). */
export const SHELF_ACTIONS = { sell: 0, return: 1, buy: 2 } as const;
export type ApiShelfAction = keyof typeof SHELF_ACTIONS;

/**
 * A transaction built for a Solana wallet (base64, the wallet pays its
 * fee): it signs it, then `solSend` sends it, once, within `validSeconds`.
 */
export interface ApiWalletTx {
  transaction: string;
  validSeconds: number;
}

// ---------------------------------------------------------------- minting Ordinals
/** What minting `count` Ordinals costs now (Rune units, sats, lamports). */
export interface ApiOrdCost {
  count: number;
  /** Rune units burned (one share of the supply per Ordinal). */
  burn: string;
  /** Rune units sold to pay `feeSats` (1% margin for price moves). */
  feeRunes: string;
  /** `burn + feeRunes`: what the balance needs. */
  needRunes: string;
  /** The inscription fee and the Bitcoin payout fee, in sats. */
  feeSats: string;
  pictureFee: string;
  withdrawalFee: string;
  /** Ordinals not minted yet. */
  free: number;
  /** A Solana wallet's rent (back when its records close). */
  rentLamports: string;
  /** Each Ordinal's record (it stays with the Ordinal while the program follows it). */
  recordRentLamports: string;
  /** The same in sats, in a Bitcoin wallet's fee (the relay pays the SOL). */
  recordRentSats: string;
}
/** Where a mint is: a Bitcoin block picks the Ordinals, then the vault inscribes them. */
export type ApiOrdStage =
  | 'waiting-block'
  | 'drawing'
  | 'drawn'
  | 'inscribing'
  | 'delivered'
  | 'cancelled';
export interface ApiOrdTake {
  pool: string;
  id: string;
  count: number;
  /** The Bitcoin block that picks them, and when they can be picked (unix seconds). */
  target: number;
  drawableAt: number;
  /** The Taproot address they go to. */
  to: string | null;
  /** The Ordinals picked (places in the collection, from 0). */
  items: number[];
  stage: ApiOrdStage;
  /** It can still be cancelled (the Runes and the fee back). */
  cancellable: boolean;
  reveal: { txid: string; confirmed: boolean } | null;
  inscriptions: { item: number; inscription: string }[];
}

// ---------------------------------------------------------------- Ordinals listed by holders
export type ApiOrdListingStatus =
  'active' | 'pending' | 'sold' | 'cancelled' | 'gone';
/** An Ordinal listed by its holder at its own price (a signed PSBT). */
export interface ApiOrdListing {
  id: number;
  item: number;
  inscription: string;
  seller: string;
  txid: string;
  vout: number;
  sats: string;
  priceSats: string;
  status: ApiOrdListingStatus;
  createdAt: number;
}
/** A pool's market of Ordinals listed by their holders (cheapest first). */
export interface ApiOrdMarket {
  pool: string;
  open: boolean;
  feeBps: number;
  minFeeSats: string;
  minPriceSats: string;
  maxPerPurchase: number;
  /** One Ordinal's Runes at the market price now (null: not known). */
  runeValueSats: string | null;
  floorSats: string | null;
  forSale: number;
  minted: number;
  listings: ApiOrdListing[];
  stats: {
    sales24h: number;
    volume24hSats: string;
    salesAll: number;
    volumeAllSats: string;
  };
  sales: {
    item: number;
    inscription: string;
    priceSats: string;
    buyer: string;
    seller: string;
    txid: string;
    at: number;
  }[];
  usdPerBtc: number | null;
  feeRate: number | null;
}
/** A wallet's Ordinals of a pool's collection, its listings and its plain BTC. */
export interface ApiOrdMarketWallet {
  address: string;
  payment: string;
  ordinals: {
    item: number;
    inscription: string;
    txid: string;
    vout: number;
    sats: string;
    listable: boolean;
    /** Why it cannot be listed (null: it can). */
    why: string | null;
    listing: ApiOrdListing | null;
  }[];
  listings: ApiOrdListing[];
  spendableSats: string | null;
  spendableCoins: number | null;
}
/** What a listing's seller signs (SIGHASH_SINGLE | ANYONECANPAY on input 0). */
export interface ApiOrdListPlan {
  psbtBase64: string;
  signInputs: { address: string; indexes: number[]; sighash: number }[];
  item: number;
  inscription: string;
  priceSats: string;
  payTo: string;
}
/**
 * A purchase to sign, or first a split of the buyer's BTC into the two
 * outputs a purchase needs (`kind: 'split'`: sign it, `ordBuySplit`, then
 * sign the purchase it returns).
 */
export type ApiOrdBuyPlan =
  | {
      kind: 'buy';
      quoteId: string;
      psbtBase64: string;
      signInputs: { address: string; indexes: number[] }[];
      priceSats: string;
      etchyFeeSats: string;
      minerFeeSats: string;
      spentSats: string;
      feeRate: number;
      vsize: number;
      expiresAt: string;
    }
  | {
      kind: 'split';
      quoteId: string;
      psbtBase64: string;
      signInputs: { address: string; indexes: number[] }[];
      splitFeeSats: string;
      priceSats: string;
      etchyFeeSats: string;
      minerFeeSats: string;
      feeRate: number;
      expiresAt: string;
    };
/** The text a seller signs (BIP-322) to take its listing off the market. */
export function ordCancelMessage(p: {
  id: number;
  address: string;
  signedAt: string;
}): string {
  return [
    'Etchy: cancel my Ordinal listing',
    String(p.id),
    p.address,
    p.signedAt,
  ].join('\n');
}

// ---------------------------------------------------------------- BTC in from a Bitcoin wallet
/** Adding BTC to a Bitcoin wallet's balance through NEAR: the payment to sign. */
export interface ApiBtcInPlan {
  unsignedTxid: string;
  psbtBase64: string;
  signInputs: Record<string, number[]>;
  sats: string;
  networkFeeSats: string;
  feeRate: number;
  /** NEAR's deposit address (the payment goes there). */
  depositAddress: string;
  /** SOL NEAR pays to the wallet's own deposit address, and at least. */
  lamports: string;
  minLamports: string;
  swapFeeLamports: string;
  /** WBTC it should bring at Pyth's price now, and at least (null: unknown). */
  expectSats: string | null;
  minSats: string | null;
  timeEstimateSecs: number | null;
}
export interface ApiBtcIn {
  depositAddress: string;
  txid: string;
  sats: string;
  at: number;
  /** NEAR's status (`SUCCESS` once paid out). */
  near: string;
  /** SOL waiting at the wallet's deposit address to be swapped (null: unknown). */
  solWaiting: string | null;
}

// ---------------------------------------------------------------- Mined Runes
export interface ApiMineRound {
  round: string;
  startsAt: number;
  open: boolean;
  results: number;
  /** Every result's weight added up; the round's Runes are shared by weight. */
  weight: string;
  budget: string;
  minDifficulty: number;
}
/** A Mined Rune's mine: the round now, the one before, and how fast it mines. */
export interface ApiMine {
  pool: string;
  mine: string;
  now: number;
  start: number;
  roundSecs: number;
  round: ApiMineRound | null;
  previous: ApiMineRound | null;
  /** The fee of one result (lamports), and its whole cost to the key now. */
  feeLamports: string;
  resultLamports: string;
  solUsd: number | null;
  /** Rune units: the whole mine, mined so far, left. */
  cap: string;
  mined: string;
  left: string;
  roundsLeft: string;
  results: string;
  resultsPerRound: number;
  divisibility: number;
  /** Market cap now and its average (sats); the speed follows the average. */
  mcap: string;
  mcapAvg: string;
  startMcap: string;
  /** Rune units per round now. */
  speed: string;
  steps: { mcap: string; runesPerRound: string }[];
  minDifficulty: number;
  difficultyFloor: number;
  targetResults: string;
  /** Where the mining fees' buybacks are locked. */
  locked: string;
}
/** One mining key's miner in a mine (`miner: null`: not opened yet). */
export interface ApiMiner {
  authority: string;
  lamports: string | null;
  /** What the key keeps (Solana's rent minimum), and what opening a miner takes. */
  keyFloor: string;
  openLamports: string;
  miner: {
    address: string;
    /** Who gets its Runes (a Solana wallet, or a Bitcoin wallet's owner). */
    owner: string;
    /** Hex: the next result hashes this (it changes after every result). */
    challenge: string;
    pendingRound: string | null;
    pendingShare: string | null;
    pendingFinal: boolean;
    unclaimed: string;
    earned: string;
    results: string;
    best: number;
    target: number;
    lastRound: string | null;
    /** Leading zero bits the next result needs now. */
    need: number;
  } | null;
}
/** What the mining key signs (`minePrepare`). */
export type ApiMineStep =
  | { kind: 'open'; pool: string; owner: string; target?: number }
  | { kind: 'mine'; pool: string; nonce: bigint | string }
  | { kind: 'claim'; pool: string }
  | { kind: 'withdraw'; to: string; pools?: string[] };
/** A message for the mining key to sign (base64), valid `validSeconds`. */
export interface ApiMineMessage {
  id: string;
  message: string;
  validSeconds: number;
  /** Withdraw: the lamports sent. */
  lamports?: string;
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
    /** Where the pool's creator fees go now (its own route), and its first buy. */
    feeRoute: (pool: string) =>
      call<ApiFeeRoute>(`/v1/pools/${pool}/fee-route`),
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
     * sale sells `amount` Rune units for SOL.
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
    /**
     * After paying NEAR: Etchy's keeper watches the deposit and swaps it
     * (for a wallet that asked `nearAdd` within the last 2 hours).
     */
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

    // ---- Ordinals collections and the pool's market for them
    /** A pool's Ordinals collection, and what each Ordinal is doing on chain. */
    collection: (pool: string) =>
      call<ApiCollection>(`/v1/pools/${pool}/collection`),
    /** The URL of an Ordinal's art file (anyone can check it against the fingerprint). */
    collectionFileUrl: (collectionId: string, item: number) =>
      `${base}/v1/collections/${collectionId}/pictures/${item}`,
    /** The pool's market for its Ordinals: both prices, and the Ordinals at or near it. */
    shelf: (pool: string) => call<ApiShelf>(`/v1/pools/${pool}/shelf`),
    /** A Bitcoin wallet's sales to the pool and its purchases on their way. */
    shelfWallet: (pool: string, bitcoinAddress: string) =>
      call<{
        pool: string;
        address: string;
        owner: string;
        sales: ApiShelfSale[];
        buying: { item: number; txid: string; vout: number }[];
      }>(
        `/v1/pools/${pool}/shelf/wallet?address=${encodeURIComponent(bitcoinAddress)}`,
      ),
    /** An Ordinal's life on record, newest first. */
    ordinalHistory: (pool: string, item: number) =>
      call<{ pool: string; item: number; events: ApiOrdinalEvent[] }>(
        `/v1/pools/${pool}/ordinals/${item}/history`,
      ),
    /**
     * Selling an Ordinal to the pool, step 1: the one Bitcoin transaction
     * the wallet signs (the Ordinal from its Taproot address, the network
     * fee from its payment address). `minSats`: the lowest price it takes
     * (default 97% of the price now).
     */
    sellToPoolPrepare: (o: {
      pool: string;
      item: number;
      ordinalsAddress: string;
      ordinalsPublicKey: string;
      paymentAddress: string;
      paymentPublicKey: string;
      minSats?: bigint;
    }) => call<ApiShelfSellPlan>('/v1/shelf/sell-prepare', o),
    /** Step 2: the signed PSBT (within 10 minutes): sent on Bitcoin. The pool pays after `need` confirmations. */
    sellToPoolSend: (o: { unsignedTxid: string; signedPsbt: string }) =>
      call<{ pool: string; item: number; txid: string }>(
        '/v1/shelf/sell-send',
        o,
      ),
    /**
     * A Bitcoin wallet at the pool's market, with ONE signed message (free:
     * Etchy's relay pays the Solana fee): `buy` one the pool holds for at
     * most `amount` sats of its Etchy balance (to its own Taproot address),
     * take the price now for one on its way below its lowest price (`sell`,
     * at least `amount`), or get it back unsold (`return`).
     */
    async shelfAction(o: {
      pool: string;
      bitcoinAddress: string;
      item: number;
      action: ApiShelfAction;
      amount: bigint;
      signMessage: (text: string) => Promise<string>;
    }) {
      const order = {
        pool: o.pool,
        bitcoinAddress: o.bitcoinAddress,
        item: o.item,
        action: SHELF_ACTIONS[o.action],
        amount: o.amount,
      };
      const words = await call<ApiOrder>('/v1/relay/shelf-order', order);
      const signature = await o.signMessage(words.text);
      return call<{ signature: string }>('/v1/relay/shelf', {
        ...order,
        nonce: words.nonce,
        expiry: words.expiry,
        signature,
      });
    },
    /**
     * A Solana wallet buys one the pool holds, with SOL (mainnet): the
     * unsigned transaction (SOL swapped to WBTC, then the buy, at most the
     * price + 1%), sent to `address` (Taproot). Sign it, then `solSend`.
     */
    solShelfBuy: (o: {
      pool: string;
      wallet: string;
      address: string;
      item: number;
    }) =>
      call<{
        transaction: string;
        pool: string;
        item: number;
        to: string;
        priceSats: string;
        maxSats: string;
        lamports: string;
      }>('/v1/sol/shelf-buy', o),

    // ---- minting Ordinals (a pool with a collection)
    /** What minting `count` Ordinals costs now (`bitcoin`: for a Bitcoin wallet). */
    ordCost: (pool: string, count = 1, o: { bitcoin?: boolean } = {}) =>
      call<ApiOrdCost>(
        `/v1/pools/${pool}/ord-cost?count=${count}${o.bitcoin ? '&btc=1' : ''}`,
      ),
    /** A wallet's mints (a Solana or bc1p address): where each is, its inscriptions once made. */
    ordTakes: (wallet: string, pool?: string) =>
      call<{ tip: number | null; takes: ApiOrdTake[] }>(
        `/v1/wallets/${wallet}/ord-takes${pool ? `?pool=${encodeURIComponent(pool)}` : ''}`,
      ),
    /** A Solana wallet mints `count` Ordinals to the Taproot `address`: sign, then `solSend`. */
    solOrdOpen: (o: {
      pool: string;
      wallet: string;
      address: string;
      count: number;
    }) =>
      call<ApiWalletTx & ApiOrdCost & { pool: string; id: string; to: string }>(
        '/v1/sol/ord-open',
        o,
      ),
    /** Cancels a Solana wallet's mint before its block (the Runes and fee back): sign, then `solSend`. */
    solOrdCancel: (o: { pool: string; wallet: string; id: string | bigint }) =>
      call<ApiWalletTx & { pool: string; id: string }>('/v1/sol/ord-cancel', o),
    /**
     * A Bitcoin wallet mints, step 1: the approval it signs for a one-time
     * `session` key (to its own Taproot address). Easier: `openOrdinals`.
     */
    ordOpenOrder: (o: {
      pool: string;
      bitcoinAddress: string;
      count: number;
      session: string;
    }) =>
      call<
        ApiOrdCost & {
          id: string;
          text: string;
          pool: string;
          to: string;
          expiry: string;
        }
      >('/v1/relay/ord-open-order', o),
    /** Step 2: the wallet's signature; returns the session key's message (then `sessionSubmit`). */
    ordOpenSend: (o: { id: string; signature: string }) =>
      call<{ id: string; message: string; expiresAt: number }>(
        '/v1/relay/ord-open',
        o,
      ),
    /**
     * A Bitcoin wallet mints `count` Ordinals with ONE signed message
     * (BIP-322): the approval covers exactly the burn plus the Runes sold
     * for the fee, so the one-time key can do nothing else. Free of SOL.
     */
    async openOrdinals(o: {
      pool: string;
      bitcoinAddress: string;
      count: number;
      signMessage: (text: string) => Promise<string>;
      session?: SessionKey;
    }) {
      const key = o.session ?? (await oneTimeSessionKey());
      const order = await call<{ id: string; text: string }>(
        '/v1/relay/ord-open-order',
        {
          pool: o.pool,
          bitcoinAddress: o.bitcoinAddress,
          count: o.count,
          session: key.publicKey,
        },
      );
      const signature = await o.signMessage(order.text);
      const prepared = await call<{ id: string; message: string }>(
        '/v1/relay/ord-open',
        { id: order.id, signature },
      );
      const sig = await key.sign(fromB64(prepared.message));
      return call<{ signature: string }>('/v1/relay/session-submit', {
        id: prepared.id,
        signature: toB64(sig),
      });
    },

    // ---- Ordinals listed by their holders (Bitcoin PSBTs, no Solana)
    /** Ordinals of the pool's collection listed by their holders, cheapest first. */
    ordMarket: (pool: string) =>
      call<ApiOrdMarket>(`/v1/pools/${pool}/ord-market`),
    /** A wallet's Ordinals of the collection (`payment`: its BTC address, default the same). */
    ordMarketWallet: (pool: string, address: string, payment?: string) =>
      call<ApiOrdMarketWallet>(
        `/v1/pools/${pool}/ord-market/wallet?address=${encodeURIComponent(address)}${payment ? `&payment=${encodeURIComponent(payment)}` : ''}`,
      ),
    /** Listing, step 1: the PSBT the seller signs (`priceSats` paid to `payTo`, default its address). */
    ordListPrepare: (o: {
      pool: string;
      address: string;
      publicKey: string;
      txid: string;
      vout: number;
      priceSats: bigint;
      payTo?: string;
    }) => call<ApiOrdListPlan>('/v1/ord-market/list-prepare', o),
    /** Step 2: the same terms and the signed PSBT: for sale. */
    ordList: (o: {
      pool: string;
      address: string;
      publicKey: string;
      txid: string;
      vout: number;
      priceSats: bigint;
      payTo?: string;
      signedPsbt: string;
    }) => call<{ listing: ApiOrdListing }>('/v1/ord-market/list', o),
    /** Off the market: the seller signs `ordCancelMessage` (BIP-322) within 10 minutes. */
    async ordListCancel(o: {
      pool: string;
      address: string;
      id: number;
      signMessage: (text: string) => Promise<string>;
    }) {
      const signedAt = new Date().toISOString();
      const signature = await o.signMessage(
        ordCancelMessage({ id: o.id, address: o.address, signedAt }),
      );
      return call<{ cancelled: number }>('/v1/ord-market/cancel', {
        pool: o.pool,
        address: o.address,
        id: o.id,
        signedAt,
        signature,
      });
    },
    /** Buying listings: the purchase to sign, or first a split of the buyer's BTC. */
    ordBuyPrepare: (o: {
      pool: string;
      /** Where the Ordinals go (Taproot). */
      ordAddress: string;
      paymentAddress: string;
      paymentPublicKey: string;
      listingIds: number[];
      feeRate?: number;
    }) => call<ApiOrdBuyPlan>('/v1/ord-market/buy-prepare', o),
    /** The signed split (kept, not sent yet): returns the purchase to sign. */
    ordBuySplit: (o: { pool: string; quoteId: string; signedPsbt: string }) =>
      call<
        Extract<ApiOrdBuyPlan, { kind: 'buy' }> & {
          splitTxid: string;
          splitFeeSats: string;
        }
      >('/v1/ord-market/buy-split', o),
    /** The signed purchase: completed with the sellers' signatures and sent. */
    ordBuy: (o: { pool: string; quoteId: string; signedPsbt: string }) =>
      call<{
        txid: string;
        splitTxid: string | null;
        items: number[];
        priceSats: string;
      }>('/v1/ord-market/buy', o),

    // ---- more for wallets
    /** A Solana wallet's Runes to a Bitcoin address (Taproot or SegWit): sign, then `solSend`. */
    solRunesOut: (o: {
      pool: string;
      wallet: string;
      address: string;
      amount: bigint;
    }) =>
      call<
        ApiWalletTx & {
          pool: string;
          to: string;
          amount: string;
          feeRunes: string;
          feeSats: string;
          rentLamports: string;
        }
      >('/v1/sol/runes-out', o),
    /**
     * Adding BTC from a Bitcoin wallet in one payment: the PSBT paying
     * NEAR, which swaps it to SOL at the wallet's own deposit address;
     * Etchy's keeper then swaps that to WBTC in its balance.
     */
    btcInPrepare: (o: {
      bitcoinAddress: string;
      paymentAddress: string;
      paymentPublicKey: string;
      sats: bigint;
    }) => call<ApiBtcInPlan>('/v1/btc-in/prepare', o),
    /** The signed PSBT (within 30 minutes): sent on Bitcoin. */
    btcInSend: (o: { unsignedTxid: string; signedPsbt: string }) =>
      call<{ txid: string; depositAddress: string; sats: string }>(
        '/v1/btc-in/send',
        o,
      ),
    /** Where an add is (by NEAR's deposit address). */
    btcIn: (depositAddress: string) =>
      call<ApiBtcIn>(`/v1/btc-in/${encodeURIComponent(depositAddress)}`),
    /** Pays a routed pool's creator fees out to its route now (anyone may ask; Etchy's relay pays the fee). */
    claimFees: (pool: string) =>
      call<{ signature: string; sats: string }>(
        `/v1/pools/${pool}/claim-fees`,
        {},
      ),

    // ---- Mined Runes
    /** A Mined Rune's mine: the round now, the one before, the speed. */
    mine: (pool: string) =>
      call<ApiMine>(`/v1/mine/${encodeURIComponent(pool)}`),
    /** One mining key's miner in a pool's mine. */
    miner: (pool: string, authority: string) =>
      call<ApiMiner>(`/v1/mine/${encodeURIComponent(pool)}/miner/${authority}`),
    /** Every miner whose Runes go to `owner`, in every mine. */
    minersOf: (owner: string) =>
      call<{
        owner: string;
        miners: {
          address: string;
          mine: string;
          authority: string;
          unclaimed: string;
          earned: string;
          pendingRound: string | null;
          results: string;
        }[];
      }>(`/v1/mine/owner/${owner}`),
    /** The message a mining key signs (`authority`: its address); then `mineSubmit`. */
    minePrepare: (o: ApiMineStep & { authority: string }) =>
      call<ApiMineMessage>('/v1/mine/prepare', o),
    /** The key's Ed25519 signature of that message (base64): sent once. */
    mineSubmit: (o: { id: string; signature: string }) =>
      call<{ signature: string }>('/v1/mine/submit', o),
    /** Prepare, sign with the mining key, submit: open, mine (a found nonce), claim or withdraw. */
    async mineSend(o: ApiMineStep & { key: SessionKey }) {
      const { key, ...step } = o;
      const m = await call<ApiMineMessage>('/v1/mine/prepare', {
        ...step,
        authority: key.publicKey,
      });
      const sig = await key.sign(fromB64(m.message));
      return call<{ signature: string }>('/v1/mine/submit', {
        id: m.id,
        signature: toB64(sig),
      });
    },
    /** A wallet funds its mining key (a plain SOL transfer): sign, then `solSend`. */
    mineFund: (o: { wallet: string; authority: string; lamports: bigint }) =>
      call<ApiWalletTx>('/v1/mine/fund', o),
    /** Any wallet claims a miner's Runes for its owner (a lost key): sign, then `solSend`. */
    mineClaimTx: (o: { wallet: string; pool: string; authority: string }) =>
      call<ApiWalletTx>('/v1/mine/claim-tx', o),
  };
}
export type EtchyApi = ReturnType<typeof createEtchyApi>;
