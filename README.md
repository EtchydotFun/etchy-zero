# Etchy Zero SDK

[![npm](https://img.shields.io/npm/v/@etchydotfun/rune-pool?color=cb3837)](https://www.npmjs.com/package/@etchydotfun/rune-pool)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![Network](https://img.shields.io/badge/network-mainnet-14f195)

TypeScript SDK for [Etchy Zero](https://etchy.fun), an automated market maker for Bitcoin Runes
on Solana.

Etchy Zero trades the Rune itself, not a token that stands in for it. Each Rune's supply is held
in a Bitcoin vault, holders' balances are accounts in the program, and trades settle on Solana in
about a second. Whenever Runes move on Bitcoin (the etching, a payout from the vault, a deposit
into it), the program verifies the transaction against Bitcoin's own chain before acting on it.

This package gives you the same access etchy.fun has: market data, exact quotes, trading from
Solana and Bitcoin wallets, moving Runes and BTC between the two chains, and the keeper that keeps
pools in step with Bitcoin.

> **Status:** live on Solana mainnet and open to everyone: launch a Rune at
> [etchy.fun/create/zero](https://etchy.fun/create/zero). Devnet stays up for testing: trades
> there use test SOL and test WBTC, while its Bitcoin transactions (launches, deposits, payouts)
> are real. Addresses for both are under [Networks](#networks).

## How it works

**Pools.** Each pool holds one Rune and trades it against WBTC on a constant-product bonding curve.
A virtual BTC reserve sets the starting market cap (0.035 BTC), and the curve remains the market
for the life of the pool. A pool opens only when someone proves its Rune's etching: the entire
premine must be paid to the pool's vault, with no open mint. On mainnet, pools exist only for new
Runes etched directly into their vault.

**First buys.** A launch can reserve a pool's first trade for its creator. Until that buy is made,
or its deadline passes, nobody else can trade, so the creator buys at the starting price. On
etchy.fun the creator pays for it together with the launch; it is made as soon as trading opens,
or paid back if the launch fails.

**Balances.** Holdings are accounts in the `rune_pool` program, keyed by owner. They support
transfers and delegated approvals like token balances, but they are not SPL tokens. An owner is
either a Solana wallet or a Bitcoin wallet; a Bitcoin wallet controls its balance with its Taproot
key, through signed messages.

**Bitcoin verification.** The `btc_relay` program is a Bitcoin light client. It accepts block
headers from anyone and follows the chain with the most work, checking proof of work, difficulty
adjustments and timestamps. `rune_pool` verifies Merkle proofs against the relay and applies the
Runestone rules of `ord` to the proven transaction. This is how it learns that a Rune was etched
into a vault, that a withdrawal was paid, or that Runes arrived in a deposit.

**The vault.** A pool's Runes sit at a Taproot address whose key is a threshold Schnorr key held
by an Internet Computer canister. The canister signs one kind of Bitcoin transaction: a batch that
pays the withdrawals the program has queued and returns every other Rune to the vault. Anyone can
then prove that transaction on Solana. If a proven transaction ever leaves the vault with fewer
Runes than the pool owes, the program halts trading in that pool and records the shortfall on
chain.

**Deposits.** Runes return to a pool when they are sent to its vault address with an `OP_RETURN`
memo naming a Solana owner. The program follows Rune outputs from the vault outward, so it credits
a deposit only for Runes whose history it has verified.

## Security model

Enforced on chain:

- Bitcoin data enters only as proofs against `btc_relay`. On mainnet, a pool accepts only a
  mainnet relay that starts from a pinned checkpoint, and requires at least six confirmations.
- Fees are taken inside each trade, at most 10% per side. No client can skip them.
- A Bitcoin wallet's order is a readable message signed with BIP-322. It names the network, the
  Rune, the side, the amounts, a nonce and an expiry, and it can be used once.

Trusted today:

- Etchy holds the upgrade authority of both programs and controls the vault canister. A public
  timelock on upgrades is planned.
- Etchy creates pools, can pause trading, and sets fee rates within the 10% cap.
- WBTC is bridged BTC, and its backing is outside this system. NEAR Intents and Jupiter are
  trusted to complete the swaps they quote; the program enforces the minimum amounts.
- A Bitcoin reorganization deeper than the confirmation requirement could reverse a proven event.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Install

```bash
npm install @etchydotfun/rune-pool @solana/web3.js
```

The package is published under the program's name, `rune-pool`. It ships as ESM with type
definitions and runs in browsers (any bundler), Node.js 18+, Bun and Deno.

| Entry point | Contents | Peer dependency |
| --- | --- | --- |
| `@etchydotfun/rune-pool` | Client, quotes, trades, API client, indexer, keeper | `@solana/web3.js` |
| `@etchydotfun/rune-pool/deposit` | Deposits built and signed in a Bitcoin wallet | `@scure/btc-signer` |
| `@etchydotfun/rune-pool/vault` | Vault canister client, for keepers | `@dfinity/agent` |
| `@etchydotfun/rune-pool/wallets` | Xverse, UniSat, Leather and OKX in the browser | none |

## Quick start

### Market data

No key or wallet is needed. The public API allows cross-origin requests, so browsers can call it
from any site.

```ts
import { createEtchyApi } from '@etchydotfun/rune-pool';

const api = createEtchyApi('https://api.etchy.fun/zero'); // devnet: /rune-pools

const pools = await api.pools({ sort: 'volume' });
const pool = await api.pool('971505:1052'); // a Rune ID, a Rune name or a pool address

const { trades, next } = await api.tradesPage(pool.pool, { limit: 100 });
const candles = await api.candles(pool.pool, '5m'); // market cap in BTC and USD
const holders = await api.holders(pool.pool);
const onBitcoin = await api.bitcoinHolders(pool.pool);

const live = api.stream((t) => console.log(t.side, t.btcAmount), { pool: pool.pool });
// live.close() when done
```

The same data can be read from the chain alone with `createPoolIndexer({ connection })`, with no
Etchy server involved. See `examples/read-chain.ts`.

The examples below use mainnet. On devnet the code is the same with a devnet RPC and
`https://api.etchy.fun/rune-pools`.

### Trading from a Solana wallet

```ts
import { Connection, Transaction } from '@solana/web3.js';
import { createRunePoolClient, formatUnits } from '@etchydotfun/rune-pool';

// Use your own RPC: the public one limits requests.
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const client = createRunePoolClient({ connection });

const pool = (await client.listPools()).find((p) => p.name === 'ETCHY•FUN')!;

// The exact result for 20,000 sats at the current price, with 1% slippage.
const quote = await client.quote(pool, 'buy', 20_000n, 100);
console.log(formatUnits(quote.amountOut, pool.divisibility), 'Runes');

// `wallet` is any Solana wallet adapter. The Runes are credited to its balance in the pool.
const buy = await client.buy({
  pool,
  trader: wallet.publicKey,
  btcIn: 20_000n,
  minRuneOut: quote.minOut,
});
await wallet.sendTransaction(new Transaction().add(...buy), connection);

// Selling pays WBTC to the wallet's WBTC account, created if missing.
const current = (await client.getPool(pool.address))!;
const back = await client.quote(current, 'sell', quote.amountOut, 100);
const sell = await client.sell({
  pool: current,
  signer: wallet.publicKey,
  runeIn: quote.amountOut,
  minBtcOut: back.minOut,
});
await wallet.sendTransaction(new Transaction().add(...sell), connection);
```

All amounts are `bigint` in base units: satoshis for BTC and WBTC, and Rune units
(`10 ** pool.divisibility` per Rune) for Runes.

### Trading from a Bitcoin wallet

A Bitcoin wallet needs no SOL. It signs a readable order with its Taproot (`bc1p`) key, and
Etchy's relay submits the order and pays the Solana fee. The program verifies the signature
itself, so a modified order fails and each order number works once.

```ts
import { createEtchyApi } from '@etchydotfun/rune-pool';

const api = createEtchyApi('https://api.etchy.fun/zero');
const { pool } = await api.pool('971505:1052');
const bitcoinAddress = 'bc1p...';

const quote = await api.quote(pool, 'buy', 10_000n, 100);
const minOut = BigInt(quote.minOut);
const order = await api.order({ pool, bitcoinAddress, side: 'buy', amount: 10_000n, minOut });

// BIP-322: Xverse `signMessage`, UniSat `signMessage(text, 'bip322-simple')`, or the
// helpers in `@etchydotfun/rune-pool/wallets`.
const signature = await wallet.signMessage(order.text);

const { signature: tx } = await api.trade({
  pool,
  bitcoinAddress,
  side: 'buy',
  amount: 10_000n,
  minOut,
  nonce: order.nonce,
  expiry: order.expiry,
  signature,
});
```

The wallet is asked to sign text like this:

```text
Etchy Zero (mainnet): buy ETCHY•FUN (Rune 971505:1052) with 0.00010000 BTC of my Etchy
balance, for at least 2942836.740124 ETCHY•FUN.
Order 2, valid until 1792611734 (unix time).
Solana program D2gyR3iREHCwmTZNop4kz4ZfAjho5mY6h4QMbJqbEKyU.
```

The signature covers these exact bytes, so always use the text returned by the relay or built by
the SDK (`tradeMessage`, `approveMessage`). The wording can change between program versions.

## Bitcoin wallets: moving BTC and Runes

BTC enters and leaves through NEAR Intents, never through an Etchy wallet.

- **Adding BTC.** NEAR swaps the wallet's BTC to SOL and pays it to the wallet's own deposit
  address on Solana, an address no one holds a key to. Anyone can then swap that SOL to WBTC in a
  single transaction, which the program accepts only at Pyth's market price or better, less a 1%
  tolerance. Etchy's keeper does this within seconds. See `nearAddQuote`, `solSwapQuote` and
  `solSwapInstructions`. With the API it is one Bitcoin payment: `api.btcInPrepare` returns the
  PSBT paying NEAR, `api.btcInSend` broadcasts it, and `api.btcIn` follows it.
- **Withdrawing BTC.** The wallet signs an order naming a Bitcoin address. One Solana transaction
  sells the WBTC for SOL and pays NEAR, which then sends BTC to that address; if the payment
  falls short, the whole transaction fails. See `nearWithdrawQuote` and
  `nearWithdrawInstructions`.
- **Runes to Bitcoin.** `api.withdrawRunes` sends Runes to the wallet's own Taproot address with
  one signature. The wallet approves a one-time key for exactly the amount, plus the Runes sold
  to pay the withdrawal fee. The vault pays the Runes in its next batch. A Solana wallet does
  the same with `api.solRunesOut` (to any Taproot or SegWit address): it signs one transaction
  and `api.solSend` sends it.
- **Runes into a pool.** `api.prepareDeposit` returns one PSBT for the wallet to sign: the Runes
  and the memo, with the fee paid from the wallet's payment address. `api.sendDeposit` broadcasts
  it, and `api.deposit` follows it until the Runes are credited. To build deposits without Etchy's
  server, use `@etchydotfun/rune-pool/deposit`.

## Ordinals collections

A Rune can launch with 200 to 1,000 art files. The supply is split evenly across them, and burning
one share mints one Ordinal on Bitcoin, a child of the Rune's logo on its own output. A Bitcoin
block mined after the burn decides which one you get, so nobody can pick. The logo also carries a
Merkle root of every file, so the art can't be swapped later.

> **Not open yet.** Ordinal Runes run on mainnet, but etchy.fun doesn't offer them to everyone
> yet. Everything below works on any pool that has a collection (`api.collection` returns 404 for
> the others).

### Minting

```ts
const cost = await api.ordCost(pool.pool, 3); // Runes burned + Runes sold for the fee

// A Bitcoin wallet: one signed message, no SOL. The Ordinals go to its own Taproot address.
await api.openOrdinals({
  pool: pool.pool,
  bitcoinAddress, // bc1p...
  count: 3,
  signMessage: (text) => wallet.signMessage(text), // BIP-322
});

// A Solana wallet: one transaction to sign, to any Taproot address.
const { transaction } = await api.solOrdOpen({ pool: pool.pool, wallet, address, count: 3 });
// sign it, then api.solSend(signedBase64)

const { takes } = await api.ordTakes(bitcoinAddress); // waiting-block, drawing, ... delivered
```

Until the block that picks them is mined, a Solana wallet can cancel a mint with
`api.solOrdCancel` and get its Runes and fee back.

### The pool's own market

Every pool buys back any minted Ordinal from its collection and resells the ones it holds. It pays
what that Ordinal's Runes would sell for right now, minus 5%, and sells at what those Runes would
cost. While the pool holds an Ordinal, its Runes stay in the reserve and can't be bought as plain
Runes.

The program tracks every minted Ordinal on Bitcoin. Anyone can submit a proof of the transaction
that spent it, and the program works out where it went (first in, first out). That's how it knows
an Ordinal reached the pool and who to pay.

```ts
const api = createEtchyApi('https://api.etchy.fun/zero');

const shelf = await api.shelf(pool.pool);
shelf.sellSats; // what the pool pays for any minted Ordinal now (sats)
shelf.buySats; // what one from the pool costs now
shelf.items.filter((x) => x.state === 'shelf'); // the Ordinals it holds

const collection = await api.collection(pool.pool);
const art = api.collectionFileUrl(collection.id, 41); // Ordinal #42
const history = await api.ordinalHistory(pool.pool, 41);
```

### Buying from the pool

A Bitcoin wallet pays from its Etchy balance with one signed message. The Ordinal goes to the
wallet's own Taproot address.

```ts
await api.shelfAction({
  pool: pool.pool,
  bitcoinAddress, // the wallet's bc1p address
  item: 41,
  action: 'buy',
  amount: (BigInt(shelf.buySats!) * 101n) / 100n, // the most it pays
  signMessage: (text) => wallet.signMessage(text), // BIP-322
});
```

From a Solana wallet, `api.solShelfBuy({ pool, wallet, address, item })` returns an unsigned
transaction that swaps SOL and buys in one go. Sign it and send it with `api.solSend`. Either way,
the Bitcoin fee comes out of the Ordinal's own output, so the buyer doesn't pay it.

### Selling to the pool

The wallet signs one Bitcoin transaction. It sends the Ordinal to the pool's address with a memo
saying who to pay and the lowest price they'll take. Once it has the pool's confirmations, any
keeper can trigger the payout and the WBTC lands in that wallet's balance. If the price has dropped
below the minimum by then, the Ordinal just waits. The seller can take the current price (`sell`)
or have it sent back (`return`).

```ts
const plan = await api.sellToPoolPrepare({
  pool: pool.pool,
  item: 17,
  ordinalsAddress, ordinalsPublicKey, // where the Ordinal is
  paymentAddress, paymentPublicKey, // pays the network fee
});
// plan.quoteSats, plan.minSats, plan.minerFeeSats: show them, then sign plan.psbtBase64.
await api.sellToPoolSend({ unsignedTxid: plan.unsignedTxid, signedPsbt });
const { sales } = await api.shelfWallet(pool.pool, ordinalsAddress); // its progress
```

The Ordinal has to sit alone on the first sat of its output, with no Runes or other inscriptions
there. The API checks this before building anything. The output gets topped up to 5,000 sats, and
those sats later pay for sending it on to the next buyer.

> **Warning:** Only send an Ordinal to the pool with a transaction built this way. Without the
> memo it gets sent back. If it isn't on the first sat, or its output is under 5,000 sats, it's
> stuck at the pool's address for good.

Solana wallets can also call `client.ordShelf` directly (sell at a new price, take it back, or buy
with WBTC), and keepers use `client.ordSellBack`. `sellBackQuote` and `shelfBuyQuote` return the
exact prices the program will use.

### Listings by holders

Holders can also list an Ordinal at their own price. A listing is a PSBT the seller signs once
(`SIGHASH_SINGLE | ANYONECANPAY`), so the Ordinal never leaves their wallet until someone buys it
in one Bitcoin transaction.

```ts
const market = await api.ordMarket(pool.pool); // listings, cheapest first, and sales
const mine = await api.ordMarketWallet(pool.pool, ordinalsAddress, paymentAddress);

// List: sign the PSBT (input 0 with the sighash it names), then send the same terms back.
const terms = { pool: pool.pool, address: ordinalsAddress, publicKey: ordinalsPublicKey,
  txid: coin.txid, vout: coin.vout, priceSats: 250_000n };
const listing = await api.ordListPrepare(terms);
await api.ordList({ ...terms, signedPsbt });

// Buy: sign what `ordBuyPrepare` returns. `kind: 'split'` first splits the buyer's BTC
// (sign it, `ordBuySplit`, then sign the purchase it returns).
const plan = await api.ordBuyPrepare({ pool: pool.pool, ordAddress, paymentAddress,
  paymentPublicKey, listingIds: [market.listings[0].id] });
await api.ordBuy({ pool: pool.pool, quoteId: plan.quoteId, signedPsbt });

// Cancel: the seller signs one message (`ordCancelMessage`).
await api.ordListCancel({ pool: pool.pool, address: ordinalsAddress, id: 7, signMessage });
```

## Mined Runes

A Mined Rune starts with part of its supply in the pool and the rest in a mine run by the
`rune_miner` program. Each round (a minute) shares its Runes among that round's results by work:
a result is a nonce whose HashWX hash of the miner's challenge has enough leading zero bits. The
speed follows the Rune's market cap averaged over about an hour: fewer Runes a round at a higher
market cap. The mined Runes land in the owner's pool balance, like any trade.

A miner is a mining key (any Ed25519 key) that the owner's wallet funds once with a plain SOL
transfer. The key signs its own results, so mining needs no wallet pop-ups, and it can only mine.

```ts
const mine = await api.mine(pool.pool); // the round now, its minimum difficulty, the speed
const { transaction } = await api.mineFund({ wallet, authority: key.publicKey, lamports: 20_000_000n });
// the wallet signs it, then api.solSend(signedBase64)

await api.mineSend({ key, kind: 'open', pool: pool.pool, owner: wallet }); // the Runes go to `owner`
const { miner } = await api.miner(pool.pool, key.publicKey);
// Find a nonce for miner.challenge at miner.need bits (HashWX), then:
await api.mineSend({ key, kind: 'mine', pool: pool.pool, nonce });
await api.mineSend({ key, kind: 'claim', pool: pool.pool });
```

`key` is any `{ publicKey, sign(bytes) }`, so it can live in the browser for as long as you mine.
`miner.ts` has the program's rules in TypeScript (rounds, shares, vardiff, difficulty) and its
instructions. The hash function itself is HashWX
([github.com/tevador/hashwx](https://github.com/tevador/hashwx)); it isn't part of this package.

## HTTP API

Base URL: `https://api.etchy.fun/zero` on mainnet and `https://api.etchy.fun/rune-pools` on devnet,
with the same paths. Amounts are strings in base units. Errors
are returned as `{ "error": "CODE" }` with an HTTP status; `RPC_BUSY` (503) means Solana's RPC
was briefly unavailable, and the request can be retried. Each IP address may make 600 GET and 60
POST requests per minute and hold 10 open streams.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/v1/pools?sort=new\|mcap\|volume\|change\|trades\|last` | Every pool: price, market cap in BTC and USD, reserves, fees, 24-hour stats |
| GET | `/v1/pools/:pool` | One pool, by address, Rune ID or Rune name |
| GET | `/v1/pools/:pool/stats` | Holders, 24-hour trades and volume, price change, all-time high |
| GET | `/v1/pools/:pool/quote?side=buy\|sell&amount=N&slippageBps=100` | Output, minimum output, fee split and price impact |
| GET | `/v1/pools/:pool/trades?limit=50&before=ID` | Trades, newest first, with a cursor for the next page |
| GET | `/v1/pools/:pool/candles?interval=5m&limit=300` | Market cap candles in BTC and USD, from 1s to 1d |
| GET | `/v1/pools/:pool/holders` | Balances in the pool, and Runes on their way to Bitcoin |
| GET | `/v1/pools/:pool/bitcoin-holders` | Holders on Bitcoin, by address |
| GET | `/v1/pools/:pool/rewards` | Fee reward rounds, for pools that pay fees to holders |
| GET, POST | `/v1/pools/:pool/fee-route`, `/v1/pools/:pool/claim-fees` | Where a pool's creator fees go; pay them out now (anyone) |
| GET | `/v1/pools/:pool/withdraw-fee` | What a withdrawal to Bitcoin costs |
| GET | `/v1/pools/:pool/logo` | The logo inscribed with the Rune |
| GET | `/v1/stream?pool=` | Server-sent events: every trade as soon as it is confirmed |
| GET | `/v1/wallets/:address/balances` | Balances of a Solana address or a Taproot address |
| GET | `/v1/wallets/:address/withdrawals?pool=` | Withdrawal requests and the Bitcoin transactions that paid them |
| POST | `/v1/relay/order`, `/v1/relay/trade` | A Bitcoin wallet's order: the text to sign, then the signed order |
| GET, POST | `/v1/pools/:pool/sol-quote`, `/v1/sol/order`, `/v1/sol/send` | A trade paid in SOL from a Solana wallet |
| POST | `/v1/relay/withdraw-runes-order`, `/v1/relay/withdraw-runes`, `/v1/relay/session-submit` | Runes to the wallet's own Taproot address |
| POST | `/v1/sol/runes-out` | A Solana wallet's Runes to a Bitcoin address (then `/v1/sol/send`) |
| POST | `/v1/deposits/prepare`, `/v1/deposits/send` | A deposit PSBT to sign, then its broadcast |
| GET | `/v1/pools/:pool/deposits/:txid` | A deposit's confirmations and state |
| GET | `/v1/wallets/:bc1p/near` | The wallet's deposit address for adding BTC through NEAR |
| POST | `/v1/relay/near-withdraw-order`, `/v1/relay/near-withdraw` | BTC to any Bitcoin address through NEAR |
| POST, GET | `/v1/btc-in/prepare`, `/v1/btc-in/send`, `/v1/btc-in/:depositAddress` | Adding BTC with one Bitcoin payment, and where it is |
| GET | `/v1/pools/:pool/collection` | A pool's Ordinals collection: its files and what each Ordinal is doing |
| GET | `/v1/collections/:id/pictures/:item` | One art file |
| GET | `/v1/pools/:pool/shelf` | The pool's market for its Ordinals: both prices, the Ordinals at or near it |
| GET | `/v1/pools/:pool/shelf/wallet?address=` | A Bitcoin wallet's sales to the pool and its purchases on their way |
| GET | `/v1/pools/:pool/ordinals/:item/history` | An Ordinal's life on record |
| POST | `/v1/shelf/sell-prepare`, `/v1/shelf/sell-send` | Selling an Ordinal to the pool: the transaction to sign, then its broadcast |
| POST | `/v1/relay/shelf-order`, `/v1/relay/shelf` | A Bitcoin wallet buys one from the pool, takes the price, or gets one back |
| POST | `/v1/sol/shelf-buy` | A Solana wallet buys one from the pool with SOL (then `/v1/sol/send`) |
| GET | `/v1/pools/:pool/ord-cost?count=&btc=1` | What minting Ordinals costs now |
| POST | `/v1/relay/ord-open-order`, `/v1/relay/ord-open` | A Bitcoin wallet mints (then `/v1/relay/session-submit`) |
| POST | `/v1/sol/ord-open`, `/v1/sol/ord-cancel` | A Solana wallet mints or cancels (then `/v1/sol/send`) |
| GET | `/v1/wallets/:address/ord-takes?pool=` | A wallet's mints and their inscriptions |
| GET | `/v1/pools/:pool/ord-market`, `/v1/pools/:pool/ord-market/wallet?address=&payment=` | Ordinals listed by their holders at their own prices; a wallet's Ordinals |
| POST | `/v1/ord-market/list-prepare`, `list`, `cancel`, `buy-prepare`, `buy-split`, `buy` | Listing, cancelling and buying them |
| GET | `/v1/mine/:pool`, `/v1/mine/:pool/miner/:key`, `/v1/mine/owner/:owner` | A mine, a mining key's miner, an owner's miners |
| POST | `/v1/mine/prepare`, `/v1/mine/submit` | What a mining key signs (open, mine, claim, withdraw), then its signature |
| POST | `/v1/mine/fund`, `/v1/mine/claim-tx` | A wallet funds its mining key, or claims for a lost one (then `/v1/sol/send`) |

`createEtchyApi` wraps every endpoint above with typed methods.

## SDK reference

| Area | Functions |
| --- | --- |
| Reads (`createRunePoolClient`) | `getConfig`, `listPools`, `getPool`, `poolOfRune`, `getBalance`, `balancesOf`, `fees`, `feeRouteOf`, `getVault`, `bitcoinWallet` |
| Quotes | `quote`, `quoteExactOut`, `quoteOnChain` |
| Trades and balances | `buy`, `sell`, `transferRunes`, `approve`, `closeBalance`, `claimRouteFees` |
| Bitcoin-wallet orders | `btcTradeOrder`, `btcTrade`, `btcApproveOrder`, `btcApprove`, `btcSendWbtcOrder`, `btcSendWbtc`, `bip322Signature` |
| Withdrawals and deposits | `requestWithdrawal`, `withdrawalsOf`, `getWithdrawal`, `cancelWithdrawal`, `closeWithdrawal`, `depositInfo` |
| History and live data | `tradesOf`, `recentTrades`, `createPoolIndexer`, `subscribeTrades`, `tradesFromLogs`, `poolStats` |
| HTTP API (`createEtchyApi`) | `pools`, `pool`, `stats`, `tradesPage`, `candles`, `holders`, `bitcoinHolders`, `rewards`, `feeRoute`, `claimFees`, `stream`, `quote`, `order`, `trade`, `withdrawRunes`, `withdrawFee`, `withdrawals`, `depositCoins`, `prepareDeposit`, `sendDeposit`, `deposit`, `solQuote`, `solOrder`, `solSend`, `solRunesOut`, `nearAdd`, `watchNearAdd`, `btcInPrepare`, `btcInSend`, `btcIn`, `nearWithdrawOrder`, `nearWithdraw` |
| NEAR and swaps | `nearAddQuote`, `nearStatus`, `solSwapQuote`, `solSwapInstructions`, `nearWithdrawQuote`, `nearWithdrawInstructions`, `jupiterRoute`, `jupiterSellRoute` |
| Ordinals collections | `getCollection`, `ordOpenCost`, `ordTakeOut`, `ordTakesOf`, `ordTakeCancel`, `getShelf`, `getOrdCoin`, `ordCoinsOf`, `ordShelf`, `ordSellBack`, `btcShelfOrder`, `btcShelf`, `sellBackQuote`, `shelfBuyQuote`, `sellMemo`, `shelfMessage`; in the API client `collection`, `collectionFileUrl`, `ordCost`, `openOrdinals`, `ordOpenOrder`, `ordOpenSend`, `solOrdOpen`, `solOrdCancel`, `ordTakes`, `shelf`, `shelfWallet`, `ordinalHistory`, `sellToPoolPrepare`, `sellToPoolSend`, `shelfAction`, `solShelfBuy`, `ordMarket`, `ordMarketWallet`, `ordListPrepare`, `ordList`, `ordListCancel`, `ordCancelMessage`, `ordBuyPrepare`, `ordBuySplit`, `ordBuy` |
| Mined Runes | `minerPda`, `decodeMine`, `decodeMiner`, `roundAt`, `roundOf`, `speedAt`, `pendingShare`, `mineLeft`, `neededOf`, `weightOf`, `nextTargetOf`, `openMinerIx`, `mineIx`, `claimIx`, `closeMinerIx`, `MINER_PROGRAM_ID`; in the API client `mine`, `miner`, `minersOf`, `minePrepare`, `mineSubmit`, `mineSend`, `mineFund`, `mineClaimTx` |
| Keeper | `createKeeper`; `createVaultCanister` and `keeperVault` from `/vault` |
| Low level | `instruction`, `pda`, `decodeAccount`, `decodeEvent`, `eventsFromLogs`, `errorName`, `IDL`, `PROGRAM_ID`, `tradeMessage`, `approveMessage`, `quoteBuy`, `quoteSell` |

Messages, memos and curve math match what the program checks, byte for byte. Trade and account
builders return instructions for you to sign and send.

## Running a keeper

A handful of permissionless jobs keep pools in step with Bitcoin: submitting block headers to the
relay, asking the canister to open vaults and to start and pay withdrawal batches, proving
payouts, and proving and crediting deposits. Etchy runs a keeper, but nothing depends on it.
Every step is checked by the program or the canister, so a keeper cannot move funds.

```ts
import { Connection } from '@solana/web3.js';
import { createKeeper, MAINNET_LOOKUP_TABLE } from '@etchydotfun/rune-pool';
import { createVaultCanister, keeperVault } from '@etchydotfun/rune-pool/vault';

const keeper = createKeeper({
  connection: new Connection(yourRpc, 'confirmed'),
  payer, // a funded Keypair: it pays Solana fees and temporary rent
  vault: keeperVault(await createVaultCanister()), // mainnet's canister
  lookupTable: MAINNET_LOOKUP_TABLE,
});

setInterval(() => keeper.tick().catch(console.error), 60_000);
```

`examples/keeper.ts` is a complete, runnable version. On devnet, pass
`{ canisterId: DEVNET_VAULT_CANISTER }` to `createVaultCanister` and use `DEVNET_LOOKUP_TABLE`.

## Networks

The programs have the same addresses on both networks.

| | Mainnet | Devnet |
| --- | --- | --- |
| `rune_pool` program | [`D2gyR3iREHCwmTZNop4kz4ZfAjho5mY6h4QMbJqbEKyU`](https://solscan.io/account/D2gyR3iREHCwmTZNop4kz4ZfAjho5mY6h4QMbJqbEKyU) | [the same](https://solscan.io/account/D2gyR3iREHCwmTZNop4kz4ZfAjho5mY6h4QMbJqbEKyU?cluster=devnet) |
| `btc_relay` program | [`9enwiwQwfPH5FSjcSo1fDViJwM8kQn5LpsrEq3uKXrbY`](https://solscan.io/account/9enwiwQwfPH5FSjcSo1fDViJwM8kQn5LpsrEq3uKXrbY) | [the same](https://solscan.io/account/9enwiwQwfPH5FSjcSo1fDViJwM8kQn5LpsrEq3uKXrbY?cluster=devnet) |
| Relay account (Bitcoin headers) | [`8jiPVfMUbrEFgbiB8CT2k5ZFrYui6kwQcnHaKpb6Zgxe`](https://solscan.io/account/8jiPVfMUbrEFgbiB8CT2k5ZFrYui6kwQcnHaKpb6Zgxe) | [`Cdn6GTeretnh72LEgTPKbP42yauqRzxtMzqdpHkeA4Tz`](https://solscan.io/account/Cdn6GTeretnh72LEgTPKbP42yauqRzxtMzqdpHkeA4Tz?cluster=devnet) |
| Vault canister (Internet Computer) | [`j22zd-eyaaa-aaaao-qqkza-cai`](https://dashboard.internetcomputer.org/canister/j22zd-eyaaa-aaaao-qqkza-cai) (`MAINNET_VAULT_CANISTER`) | [`rdl3p-uqaaa-aaaaa-qhvpq-cai`](https://dashboard.internetcomputer.org/canister/rdl3p-uqaaa-aaaaa-qhvpq-cai) (`DEVNET_VAULT_CANISTER`) |
| Lookup table | [`C6DTPV3SKeunnPvtbbzZbjLNFG2u5nhFN2ognYiyUN4g`](https://solscan.io/account/C6DTPV3SKeunnPvtbbzZbjLNFG2u5nhFN2ognYiyUN4g) (`MAINNET_LOOKUP_TABLE`) | [`9drGTuME311J1BoYDVeNc5QSK4RpuH4kp8T8Uv1tHNgV`](https://solscan.io/account/9drGTuME311J1BoYDVeNc5QSK4RpuH4kp8T8Uv1tHNgV?cluster=devnet) (`DEVNET_LOOKUP_TABLE`) |
| Quote token | WBTC (Wormhole) `3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh` | a test token |
| Bitcoin proofs | 6 confirmations | 2 confirmations |
| HTTP API | `https://api.etchy.fun/zero` | `https://api.etchy.fun/rune-pools` |

## Examples

| File | What it shows |
| --- | --- |
| `examples/read-api.ts [runeId] [wallet]` | Market data from the HTTP API: pools, trades, candles, holders, rewards, a wallet's balances, live trades |
| `examples/read-chain.ts` | The same from the chain alone: quotes, trades, candles, holders on Solana and on Bitcoin |
| `examples/keeper.ts <key.json>` | A keeper |

They run on mainnet. Set `SOLANA_RPC` to your own RPC, and `NETWORK=devnet` for devnet
(`read-api.ts`: `ETCHY_POOL_API=https://api.etchy.fun/rune-pools`).

```bash
npm install
SOLANA_RPC=https://... node --experimental-strip-types examples/read-chain.ts   # Node.js 22.6 or later
```

To build the package from source, run `npm run build`. It compiles to `dist/` and then checks
that the output loads in Node.js and bundles for the browser.

## Changes

**0.5.0**

- Mainnet by default: `createVaultCanister()` uses `MAINNET_VAULT_CANISTER` (it used the devnet
  canister when no `canisterId` was given). The examples run on mainnet (`examples/keeper.ts`,
  `examples/read-chain.ts`; `NETWORK=devnet` for devnet) and the README's code uses mainnet.
- API client: every public endpoint has a method. New: minting Ordinals (`ordCost`,
  `openOrdinals`, `ordOpenOrder`, `ordOpenSend`, `solOrdOpen`, `solOrdCancel`, `ordTakes`),
  Ordinals listed by holders (`ordMarket`, `ordMarketWallet`, `ordListPrepare`, `ordList`,
  `ordListCancel`, `ordBuyPrepare`, `ordBuySplit`, `ordBuy`, `ordCancelMessage`), Mined Runes
  (`mine`, `miner`, `minersOf`, `minePrepare`, `mineSubmit`, `mineSend`, `mineFund`,
  `mineClaimTx`), `solRunesOut`, `btcInPrepare`, `btcInSend`, `btcIn` and `claimFees`.
- `ApiPool.mined`: a Mined Rune's mine in brief.
- Mined Runes: `miner.ts` (the `rune_miner` program's accounts, rules and instructions). See
  [Mined Runes](#mined-runes).

**0.4.0**

- Ordinals collections: reading a collection and its states, minting (`ordOpenCost`,
  `ordTakeOut`, `ordTakesOf`, `ordTakeCancel`), and the pool's market for its Ordinals
  (`getShelf`, `ordCoinsOf`, `ordShelf`, `btcShelf`, `sellBackQuote`, `shelfBuyQuote`). See
  [Ordinals collections](#ordinals-collections).
- API client: `collection`, `shelf`, `shelfWallet`, `ordinalHistory`, `sellToPoolPrepare`,
  `sellToPoolSend`, `shelfAction`, `solShelfBuy`.
- Keeper: follows every minted Ordinal on Bitcoin, pays sellers at the pool, and asks the vault to
  send the Ordinals the pool sells. Keepers must upgrade: `ord_delivered` takes new accounts.
- A buy of plain Runes never takes the Runes of the Ordinals the pool holds (`quote` refuses it
  with `InsufficientLiquidity`, like the program).

**0.3.0**

- Mainnet: `MAINNET_VAULT_CANISTER`, `MAINNET_LOOKUP_TABLE` and the addresses above.
- Early trading: a new pool can trade before its etching is proven (`POOL_EARLY`, `pool.early`,
  `pool.earlyUntil`, `pool.proven`). Runes move to and from Bitcoin only after the proof.
- First buys: `pool.firstBuy` (amount, buyer and deadline), from the chain and from the API.
- Fee routes: `feeRouteOf` and `claimRouteFees` (anyone can pay out a routed pool's creator
  fees), and `feeRoute` in the API.
- Keeper: proofs keep working for blocks the relay no longer holds (`rememberBlock`), Runes
  added to a spend that was already proven are credited by a second proof
  (`reprove_coin_spend`), and the vault's withdrawal fee follows Bitcoin fees (`withdrawalFee`).
  Keepers must upgrade: the program's proof instructions changed.
- `closeBalance` returns the rent to whoever paid it.
- Messages signed by Bitcoin wallets start with `Etchy Zero (mainnet)` or `Etchy Zero (devnet)`
  and end with the program's address. Build them with `tradeMessage` and `approveMessage`.

## License

[Apache License 2.0](LICENSE)
