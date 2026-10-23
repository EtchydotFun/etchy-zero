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

> **Status:** live on Solana mainnet. New launches are open to a short list of wallets while the
> first ones are tested. Devnet stays up for testing: trades there use test SOL and test WBTC,
> while its Bitcoin transactions (launches, deposits, payouts) are real. Addresses for both are
> under [Networks](#networks).

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
Etchy server involved. See `examples/read-devnet.ts`.

The examples below use devnet, where pools exist to try things with test funds. On mainnet the
code is the same with a mainnet RPC and `https://api.etchy.fun/zero`.

### Trading from a Solana wallet

```ts
import { Connection, Transaction } from '@solana/web3.js';
import { createRunePoolClient, formatUnits } from '@etchydotfun/rune-pool';

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
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

const api = createEtchyApi('https://api.etchy.fun/rune-pools');
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
Etchy Zero (devnet): buy ETCHY•FUN (Rune 971505:1052) with 0.00010000 BTC of my Etchy
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
  `solSwapInstructions`.
- **Withdrawing BTC.** The wallet signs an order naming a Bitcoin address. One Solana transaction
  sells the WBTC for SOL and pays NEAR, which then sends BTC to that address; if the payment
  falls short, the whole transaction fails. See `nearWithdrawQuote` and
  `nearWithdrawInstructions`.
- **Runes to Bitcoin.** `api.withdrawRunes` sends Runes to the wallet's own Taproot address with
  one signature. The wallet approves a one-time key for exactly the amount, plus the Runes sold
  to pay the withdrawal fee. The vault pays the Runes in its next batch.
- **Runes into a pool.** `api.prepareDeposit` returns one PSBT for the wallet to sign: the Runes
  and the memo, with the fee paid from the wallet's payment address. `api.sendDeposit` broadcasts
  it, and `api.deposit` follows it until the Runes are credited. To build deposits without Etchy's
  server, use `@etchydotfun/rune-pool/deposit`.

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
| GET | `/v1/pools/:pool/logo` | The logo inscribed with the Rune |
| GET | `/v1/stream?pool=` | Server-sent events: every trade as soon as it is confirmed |
| GET | `/v1/wallets/:address/balances` | Balances of a Solana address or a Taproot address |
| GET | `/v1/wallets/:address/withdrawals?pool=` | Withdrawal requests and the Bitcoin transactions that paid them |
| POST | `/v1/relay/order`, `/v1/relay/trade` | A Bitcoin wallet's order: the text to sign, then the signed order |
| GET, POST | `/v1/pools/:pool/sol-quote`, `/v1/sol/order`, `/v1/sol/send` | A trade paid in SOL from a Solana wallet |
| POST | `/v1/relay/withdraw-runes-order`, `/v1/relay/withdraw-runes`, `/v1/relay/session-submit` | Runes to the wallet's own Taproot address |
| POST | `/v1/deposits/prepare`, `/v1/deposits/send` | A deposit PSBT to sign, then its broadcast |
| GET | `/v1/pools/:pool/deposits/:txid` | A deposit's confirmations and state |
| GET | `/v1/wallets/:bc1p/near` | The wallet's deposit address for adding BTC through NEAR |
| POST | `/v1/relay/near-withdraw-order`, `/v1/relay/near-withdraw` | BTC to any Bitcoin address through NEAR |

`createEtchyApi` wraps every endpoint with typed methods.

## SDK reference

| Area | Functions |
| --- | --- |
| Reads (`createRunePoolClient`) | `getConfig`, `listPools`, `getPool`, `poolOfRune`, `getBalance`, `balancesOf`, `fees`, `feeRouteOf`, `getVault`, `bitcoinWallet` |
| Quotes | `quote`, `quoteExactOut`, `quoteOnChain` |
| Trades and balances | `buy`, `sell`, `transferRunes`, `approve`, `closeBalance`, `claimRouteFees` |
| Bitcoin-wallet orders | `btcTradeOrder`, `btcTrade`, `btcApproveOrder`, `btcApprove`, `btcSendWbtcOrder`, `btcSendWbtc`, `bip322Signature` |
| Withdrawals and deposits | `requestWithdrawal`, `withdrawalsOf`, `getWithdrawal`, `cancelWithdrawal`, `closeWithdrawal`, `depositInfo` |
| History and live data | `tradesOf`, `recentTrades`, `createPoolIndexer`, `subscribeTrades`, `tradesFromLogs`, `poolStats` |
| HTTP API (`createEtchyApi`) | `pools`, `pool`, `stats`, `tradesPage`, `candles`, `holders`, `bitcoinHolders`, `rewards`, `stream`, `quote`, `order`, `trade`, `withdrawRunes`, `withdrawals`, `depositCoins`, `prepareDeposit`, `sendDeposit`, `deposit`, `solQuote`, `solOrder`, `solSend` |
| NEAR and swaps | `nearAddQuote`, `nearStatus`, `solSwapQuote`, `solSwapInstructions`, `nearWithdrawQuote`, `nearWithdrawInstructions`, `jupiterRoute`, `jupiterSellRoute` |
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
import { createKeeper } from '@etchydotfun/rune-pool';
import { createVaultCanister, keeperVault } from '@etchydotfun/rune-pool/vault';

const keeper = createKeeper({
  connection: new Connection('https://api.devnet.solana.com', 'confirmed'),
  payer, // a funded Keypair: it pays Solana fees and temporary rent
  vault: keeperVault(await createVaultCanister()),
});

setInterval(() => keeper.tick().catch(console.error), 60_000);
```

`examples/keeper-devnet.ts` is a complete, runnable version. On mainnet, pass
`{ canisterId: MAINNET_VAULT_CANISTER }` to `createVaultCanister` and use `MAINNET_LOOKUP_TABLE`.

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
| `examples/read-devnet.ts` | The same from the chain alone: quotes, trades, candles, holders on Solana and on Bitcoin |
| `examples/keeper-devnet.ts <key.json>` | A keeper on devnet |

```bash
npm install
node --experimental-strip-types examples/read-devnet.ts   # Node.js 22.6 or later
```

To build the package from source, run `npm run build`. It compiles to `dist/` and then checks
that the output loads in Node.js and bundles for the browser.

## Changes

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
