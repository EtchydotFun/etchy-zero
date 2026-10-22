# @etchydotfun/rune-pool

**Etchy Rune Pools**: an AMM for new Bitcoin Runes. Trade **real Runes at Solana speed**, from
any site, wallet, bot or terminal.

- **New coins only.** A pool exists only for a Rune launched into its own vault (the program
  checks the etching's Bitcoin proof). Pools for existing Runes are turned off for good.
- **Every coin starts at the same market cap**, like pump.fun, but in BTC: 0.035 BTC.
- **BTC comes in and goes out only through NEAR Intents.** Etchy holds no Bitcoin for anyone.

Every Etchy coin is a real Rune on Bitcoin. Its Runes sit in a Bitcoin vault that no single
party holds the key to. Trading happens inside the coin's pool on Solana, against WBTC, so a
buy or sale settles in about a second. When a holder wants the real Runes on Bitcoin, the pool
pays them out of the vault. Runes sent back to the vault are credited to the sender after 1–2
Bitcoin blocks, and the sender can sell them whenever.

This package does what etchy.fun does:

- read pools, prices, balances and trades;
- quote exactly what a trade will give;
- build buy, sell, send and withdraw instructions for Solana wallets;
- let **Bitcoin wallets** trade with no SOL: the wallet signs a plain-text order, and Etchy's
  relay sends it.

> Status: **devnet test**. The program, the vault and the API run on Solana devnet with test
> WBTC. Addresses and URLs will change for mainnet.

## Fees

Every trade pays **1.5%**, whoever sends it: etchy.fun, your site, a bot, or someone calling
the program directly. The **program** takes the fee inside the trade itself, so no client can
skip it. All of it is Etchy's (`pool.protocolFees`; the creator part is 0 in the default fee
mode). Only Etchy's fee authority can claim it.

Your platform may charge **its own fee on top**. For example, add a WBTC transfer to your own
account in the same transaction. That fee is yours. Etchy's fee is taken either way.

`quote()` returns the exact fee split for each trade (`fee.total`, `fee.creator`,
`fee.protocol`).

## Install

```bash
npm i @etchydotfun/rune-pool @solana/web3.js
```

Compiled ESM JavaScript with type definitions: browsers (any bundler), Node 18+, Bun, Deno.
Optional extras: `@etchydotfun/rune-pool/deposit` (needs `@scure/btc-signer`),
`@etchydotfun/rune-pool/vault` (needs `@dfinity/agent`), `@etchydotfun/rune-pool/wallets` (browser
wallets, no dependency). Build from source: `npm run build` (tsc, then a Node load test and a
browser bundle test).

## Two ways in

| | Who signs | Who pays the Solana fee | Use |
|---|---|---|---|
| **SDK** (`createRunePoolClient`) | the user's Solana wallet | the user | Solana wallets, bots, terminals |
| **API** (`createEtchyApi`) | the user's Bitcoin wallet (BIP-322 message) | Etchy's relay | Bitcoin wallets (Xverse, UniSat, Leather, ...) |

You can mix them. For example, use the SDK for reads and quotes on your own RPC, and the API
only to relay Bitcoin-wallet orders.

## Quick start (Solana wallet)

```ts
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { createRunePoolClient, formatUnits } from '@etchydotfun/rune-pool';

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const pools = createRunePoolClient({ connection });

// 1. Find a pool: all of them, or by Rune id.
const all = await pools.listPools();
const pool = all.find((p) => p.name === 'ETCHY•FUN')!;

// 2. Quote: the exact result the program will give right now.
const q = await pools.quote(pool, 'buy', 20_000n /* sats */, 100 /* 1% slippage */);
console.log(formatUnits(q.amountOut, pool.divisibility), 'Runes, fee', q.fee);

// 3. Buy with the wallet's WBTC. The Runes go to its pool balance.
const ixs = await pools.buy({
  pool,
  trader: wallet.publicKey,
  btcIn: 20_000n,
  minRuneOut: q.minOut,
});
await wallet.sendTransaction(new Transaction().add(...ixs), connection);

// 4. Sell. The WBTC goes to the wallet's WBTC account (created if missing).
const sell = await pools.sell({
  pool: await pools.getPool(pool.address).then((p) => p!),
  signer: wallet.publicKey,
  runeIn: q.amountOut,
  minBtcOut: 1n,
});
```

Amounts are `bigint` in base units: sats for BTC and WBTC, and Rune units
(`10 ** pool.divisibility` per whole Rune) for Runes.

## Quick start (Bitcoin wallet, through the relay)

The user signs a readable order with their Taproot (`bc1p...`) address. The relay checks it
and sends it. The program checks the signature again. A changed order fails
(`BAD_BTC_SIGNATURE`), and each order number works once (`BAD_NONCE`).

```ts
import { createEtchyApi } from '@etchydotfun/rune-pool';

const api = createEtchyApi('https://<etchy pool api>');

// 1. Quote, then ask for the order text.
const q = await api.quote(pool, 'buy', 10_000n, 100);
const order = await api.order({
  pool,
  bitcoinAddress: 'bc1p...',
  side: 'buy',
  amount: 10_000n,
  minOut: BigInt(q.minOut),
});
// order.text, for example:
//   Etchy Rune Pools (mainnet): buy ETCHY•FUN (Rune 971505:1052) with 0.00010000 BTC of my
//   Etchy balance, for at least 2942836.740124 ETCHY•FUN.
//   Order 2, valid until 1792611734 (unix time).
// Every text names the network ("(devnet)" on devnet): one signed for devnet never works
// on mainnet.

// 2. The wallet signs it (BIP-322 "sign message", e.g. Xverse signMessage / UniSat
//    signMessage(text, 'bip322-simple')).
const signature = await wallet.signMessage(order.text);

// 3. The relay sends it (about 1-2 s).
const { signature: tx } = await api.trade({
  pool,
  bitcoinAddress: 'bc1p...',
  side: 'buy',
  amount: 10_000n,
  minOut: BigInt(q.minOut),
  nonce: order.nonce,
  expiry: order.expiry,
  signature,
});
```

A Bitcoin wallet's balances belong to its own program account (`pools.bitcoinWallet(address)`
returns it). They work exactly like a Solana wallet's balances.

## BTC in and out, through NEAR (Bitcoin wallets)

A Bitcoin wallet's WBTC lives in a WBTC account owned by its program account. No key exists
for that account: only the wallet's own signatures move the WBTC. A sale always pays WBTC
into that account. Bitcoin moves only through NEAR Intents, never through an Etchy wallet.

### Add BTC

Every Bitcoin wallet has a SOL deposit address, `pda.btcSol(taprootKey(bc1p))`. Nobody holds
its key.

1. **The browser asks NEAR's 1Click directly** (it allows any web page): call
   `nearAddQuote({ sats, depositSol, refundTo })`.
   - It is a BTC to SOL quote, with the wallet's SOL deposit address as the recipient.
   - Refunds go to the user's own Bitcoin address.
   - The quote is checked field by field.
   - The wallet sends `amountIn` sats to `depositAddress`.
   - Every quote has its own deposit address, so any number of users can deposit at once.
   - NEAR: 8,300 sats minimum, about 5 BTC maximum per swap, about 13 minutes.
2. **Anyone swaps the SOL into WBTC** in one transaction, built by `solSwapInstructions`:
   `sol_swap_begin`, then any route (for example `jupiterRoute`) paying the wallet's swap
   inbox, then `sol_swap_end`.
   - The program refuses less than Pyth's BTC/USD and SOL/USD market value, less the
     tolerance (1%).
   - The sender keeps the fixed `swap_fee_lamports`, which pays its Solana fees and rent.
   - Etchy runs a keeper that does this within seconds. Anyone else can do it too, with
     `solSwapQuote` and `solSwapInstructions`.

`POST /v1/sol-swap/watch { bitcoinAddress }` tells Etchy's keeper to look now.
`GET /v1/wallets/:bc1p/near` shows the deposit address, the SOL waiting and what it would
swap for.

SDK: `nearAddQuote`, `nearStatus`, `solDeposit`, `solSwapQuote`, `solSwapInstructions`,
`jupiterRoute`, `parsePyth`, `minSwapOut`.

### Withdraw to Bitcoin

1. **Quote.** `POST /v1/relay/near-withdraw-order { bitcoinAddress, amount, to }`. The relay
   asks NEAR for a SOL to BTC quote paying `to` (refunds go back to the wallet's SOL deposit
   address, where they turn into WBTC again). It returns NEAR's Solana deposit address, the
   SOL that goes there (`minLamports`), the BTC NEAR expects to pay (`btcOut`), and the text.
2. **Sign.** The wallet signs, for example: "Etchy Rune Pools (mainnet): withdraw
   0.00100000 BTC of my Etchy balance to bc1q... through NEAR: sell it for at least
   0.790000000 SOL sent to NEAR's deposit address 7xKX...."
3. **Send.** `POST /v1/relay/near-withdraw { id, signature }`. One Solana transaction:
   - `near_withdraw_begin` gives the WBTC to the sender (here Etchy's relay);
   - the sender swaps it to SOL and pays `minLamports` to NEAR's deposit address;
   - `near_withdraw_end` checks that the deposit address got it.

   Anything less and nothing happens. The program also refuses unless that SOL (plus the
   sender's small fee) is worth the WBTC at Pyth's prices, less the tolerance (1%). NEAR then
   pays the BTC (about 13 minutes); `nearStatus(deposit)` follows it.

Anyone can send withdrawals, not only Etchy's relay: `nearWithdrawInstructions` builds the
transaction (with `jupiterSellRoute` for the swap), `nearWithdrawCheck` gives the least SOL
the program accepts.

SDK: `nearWithdrawQuote`, `nearWithdrawMessage`, `nearWithdrawAllowed`, `nearWithdrawFloor`,
`nearWithdrawInstructions`, `jupiterSellRoute`, `scriptAddress`, `addressScript`.

## API reference

Base URL: Etchy's pool API (devnet test). All amounts are strings in base units. Errors are
`{ "error": "CODE" }` with an HTTP status. The limit is 60 requests per minute per IP.

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/pools?sort=new\|mcap\|volume\|change\|trades\|last` | `{ pools: ApiPool[] }`: every pool, with price, market cap (BTC, USD), reserves, fees, vault address, `stats` |
| GET | `/v1/pools/:pool` | `ApiPool` |
| GET | `/v1/pools/:pool/stats` | holders, 24h trades, volume, change, ATH |
| GET | `/v1/stream?pool=` | Server-Sent Events: `event: trade`, every trade the moment it is confirmed |
| GET | `/v1/pools/:pool/quote?side=buy\|sell&amount=N&slippageBps=100` | `ApiQuote`: `amountOut`, `minOut`, `fee`, `impactBps` |
| GET | `/v1/pools/:pool/trades?limit=50&before=id` | `{ trades: ApiTrade[], total, next, btcUsd }`, newest first |
| GET | `/v1/pools/:pool/candles?interval=5s&limit=300` | market cap candles `btc` and `usd`, `now`, `btcUsd` |
| GET | `/v1/pools/:pool/holders` | pool balances, `curve`, `toBitcoin`, `onBitcoin` |
| GET | `/v1/pools/:pool/bitcoin-holders` | holders on Bitcoin, by address |
| GET | `/v1/wallets/:address/balances` | a Solana address or a `bc1p...` address: its pool balances and WBTC |
| GET | `/v1/wallets/:bc1p/near` | the wallet's SOL deposit address (NEAR's recipient), SOL waiting, the swap minimum |
| POST | `/v1/sol-swap/watch` | `{ bitcoinAddress }`: Etchy's keeper watches that deposit (it also finds them alone) |
| POST | `/v1/relay/near-withdraw-order` | `{ bitcoinAddress, amount, to }` → `{ id, text, deposit, minLamports, btcOut, btcOutMin, nonce, expiry }` (valid 2 min) |
| POST | `/v1/relay/near-withdraw` | `{ id, signature }` → `{ signature }` (Solana tx) |
| POST | `/v1/relay/order` | `{ pool, bitcoinAddress, side, amount, minOut }` → `{ text, nonce, expiry }` (valid 2 min) |
| POST | `/v1/relay/trade` | the same fields plus `nonce`, `expiry`, `signature` (BIP-322, base64) → `{ signature }` (Solana tx) |

## SDK reference (`createRunePoolClient({ connection })`)

Reads:

- `getConfig()`: the fee modes, the WBTC mint, the pause flags, the network named in signed
  texts, and the launch rules (`launchOnly`, `startMcap`).
- `listPools()`, `getPool(address)`, `poolOfRune(block, tx)` (the pool address of a Rune id).
- `getBalance(pool, owner)`, `balancesOf(owner)`: Rune balances inside pools.
- `fees(pool)`: the pool's fee rates (buy and sell, total and creator part).
- `getVault(pool)`: the Bitcoin vault (address, Runes held, withdrawals).
- `bitcoinWallet(bc1pAddress)`: that wallet's program account, WBTC account and next order
  number.

Quotes:

- `quote(pool, 'buy' | 'sell', amountIn, slippageBps)`: exact, computed locally with the
  program's own math.
- `quoteExactOut(pool, runeOut)`: sats needed to buy at least `runeOut`.
- `quoteOnChain(pool, side, amount, payer)`: the program's own answer, simulated.

Trades (each returns instructions; you sign and send):

- `buy`, `sell`.
- `transferRunes`: instant, inside the pool, to any owner.
- `btcTrade`: submit a Bitcoin wallet's signed order yourself, if you run your own relay.

Bitcoin wallets without Etchy's relay (the wallet signs the text, BIP-322; anyone may send
it and pays its Solana fee; Etchy's fee is taken on every trade either way):

- `btcTradeOrder({ pool, bitcoinAddress, isBuy, amount, minOut })` then `btcTrade`.
- `btcApproveOrder({ pool, bitcoinAddress, delegate, amount })` then `btcApprove`: let a
  session key sell, send or withdraw up to `amount` (0 revokes). A Bitcoin wallet withdraws
  its Runes to Bitcoin this way: the session key calls `requestWithdrawal` with
  `owner = bitcoinWallet(address).owner`.
- `btcSendWbtcOrder({ bitcoinAddress, to, amount })` then `btcSendWbtc`: WBTC to a Solana
  wallet.
- `bip322Signature(walletAnswer)`: the 64-byte signature the program checks, from the
  base64 answer of Xverse, UniSat or Leather.

Balances and withdrawals:

- `approve({ pool, owner, delegate, amount })` (Solana wallets; 0 revokes),
  `closeBalance({ pool, owner })` (an empty balance; rent back).
- `withdrawalsOf(owner, pool?)`, `getWithdrawal(pool, id)`: status (`pending`, `in-batch`,
  `delivered`), destination address, the Bitcoin txid once paid.
- `cancelWithdrawal({ pool, id, signer })`: while still `pending`; Runes and fee back.
- `closeWithdrawal({ pool, id, closer })`: once delivered; rent back to whoever paid it.

Launching a coin is done on etchy.fun only.

Bitcoin:

- `requestWithdrawal({ pool, signer, amount, script })`: real Runes out to a Bitcoin address.
  The vault pays them in its next batch.
- `depositInfo(pool, owner)`: where to send Runes back to the vault, and the `OP_RETURN` memo
  that credits them to `owner`. They are credited after 1–2 confirmations.
- `@etchydotfun/rune-pool/deposit` (needs `@scure/btc-signer`): the whole deposit as ONE
  transaction the wallet signs. `depositableCoins` (the wallet's coins the pool knows),
  `depositTransaction` (a PSBT plus `signInputs` for `signPsbt`), `finishDeposit`,
  `sendDeposit`, `depositStatus`, `depositOwnerOf(bc1p)`.

The pool's record (`createPoolIndexer({ connection })`, from the chain only):

- `sync(pool)`, then `trades(pool, { limit, before })`;
- `candles(pool, interval)`: 1s, 5s, 15s, 30s, 1m, 5m, 15m, 30m, 1h, 4h or 1d. Market cap
  candles in BTC and USD (Pyth's BTC price);
- `holders(pool)`: pool balances (Bitcoin wallets by their bc1p address), the curve, and
  Runes on their way to Bitcoin;
- `bitcoinHolders(pool)`: who holds the Rune on Bitcoin (withdrawn), from the pool's proven
  records.

The keeper (`createKeeper({ connection, payer, vault })`, vault from
`@etchydotfun/rune-pool/vault`): anyone can run what keeps pools working (Bitcoin headers, vault
batches, payout proofs, deposits). See `examples/keeper-devnet.ts`.

History:

- `tradesOf(signature)`: the trades in one transaction, decoded from the program's `Trade`
  events.
- `recentTrades(pool, limit, cache?)`: the pool's latest trades. Pass a `Map` as `cache` to read
  each transaction only once.

Lower level:

- `instruction(name, args, accounts)`: any of the program's instructions, from the IDL.
- `pda.*`, `decodeAccount`, `decodeEvent`, `eventsFromLogs`, `errorName`.
- Math (`quoteBuy`, `quoteSell`, `priceE18`, ...) and messages (`tradeMessage`,
  `approveMessage`, `formatSpacedRune`, ...). These are byte for byte what the program
  checks.

## Live data

Every trade the moment it is confirmed, two ways:

- From the chain, no Etchy server: `subscribeTrades(connection, onTrade, { pool? })` (a
  WebSocket log subscription; returns the unsubscribe function). `tradesFromLogs` decodes any
  transaction's logs the same way.
- From Etchy's API: `createEtchyApi(url).stream(onTrade, { pool? })` (Server-Sent Events over
  fetch, reconnects by itself; `close()`). Browsers can also use
  `new EventSource(url + '/v1/stream?pool=...')`, `event: trade`.

A trade can come twice around a reconnect: key on `id` (`signature:index`).

## Coin lists

- `api.pools({ sort })`: `new`, `mcap`, `volume`, `change`, `trades` or `last`. Every pool has
  `stats`: holders, 24h trades (buys, sells, traders), 24h volume (sats and USD), 24h change,
  all-time-high market cap, last trade time.
- `api.stats(pool)`, or from the chain: `poolStats(trades, now, btcUsd)` and
  `createPoolIndexer(...).stats(pool)` / `.holderCount(pool)`.

## Wallets (browser)

```ts
import { installedWallets, signOrder } from '@etchydotfun/rune-pool/wallets';

const [provider] = installedWallets(); // Xverse, UniSat, Leather, OKX: those in the browser
const wallet = await provider.connect();
// wallet.ordinals: the Taproot address (Runes and the pool balance); wallet.payment: BTC for fees
const order = await sdk.btcTradeOrder({ pool, bitcoinAddress: wallet.ordinals.address, isBuy: true, amount: 10_000n, minOut });
const { signature, raw } = await signOrder(wallet, order.text); // `signature` for Etchy's relay, `raw` for btcTrade
const signedPsbt = await wallet.signPsbt(deposit.psbtBase64, deposit.signInputs); // a deposit
```

Single-address wallets (UniSat, OKX) must be on a Taproot (bc1p) address. Refusals throw a
`WalletError` with the wallet's own words.

## Examples

- `examples/read-devnet.ts`: no key, no Etchy server. Pools, an exact quote, the latest
  trades, market cap candles in BTC and USD, holders on Solana and on Bitcoin, then live
  trades.
- `examples/keeper-devnet.ts <devnet key.json>`: run your own keeper.

```bash
npm install
node --experimental-strip-types examples/read-devnet.ts
```

## Links

- Etchy: https://etchy.fun
- Source: https://github.com/EtchydotFun/rune-pool
- Security: security@etchy.fun (see `SECURITY.md`)
