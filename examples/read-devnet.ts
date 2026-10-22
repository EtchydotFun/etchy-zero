/**
 * Read Etchy Rune Pools on devnet: no key, no Etchy server. Lists the
 * pools, quotes a buy exactly as the program will run it, reads the latest
 * trades, market cap candles in BTC and USD, holders on Solana and on
 * Bitcoin, and then prints trades live as they happen.
 *
 *   npx tsx examples/read-devnet.ts        (or: node --experimental-strip-types)
 */
import { Connection } from '@solana/web3.js';
import {
  createPoolIndexer,
  createRunePoolClient,
  formatUnits,
  marketCapBtc,
  subscribeTrades,
} from '../src/index.ts';

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const sdk = createRunePoolClient({ connection });
const indexer = createPoolIndexer({ connection });

const pools = (await sdk.listPools()).filter((p) => p.active);
for (const p of pools)
  console.log(
    `${p.name} (Rune ${p.runeId}): market cap ${marketCapBtc(p.priceE18, p.supply, p.divisibility).toFixed(5)} BTC, ${p.trades} trades`,
  );
const pool = pools[0];
if (!pool) throw new Error('no active pool on devnet');

const q = await sdk.quote(pool, 'buy', 10_000n, 100);
console.log(
  `\n10,000 sats buy ${formatUnits(q.amountOut, pool.divisibility)} ${pool.name} (fee ${q.fee.total} sats, impact ${q.impactBps / 100}%)`,
);

await indexer.sync(pool.address);
const { trades, total } = await indexer.trades(pool.address, { limit: 5 });
console.log(`\nlatest of ${total} trades:`);
for (const t of trades)
  console.log(
    `  ${new Date(t.time * 1000).toISOString()} ${t.side} ${formatUnits(t.runeAmount, pool.divisibility)} for ${t.btcAmount} sats`,
  );

const c = await indexer.candles(pool.address, '1h', { limit: 3 });
console.log(`\nBTC = $${c.btcUsd ?? '?'}; last hourly candles (market cap, BTC):`);
for (const k of c.btc) console.log(`  ${new Date(k.time * 1000).toISOString()} open ${k.open.toFixed(5)} close ${k.close.toFixed(5)}`);

const h = await indexer.holders(pool.address);
const b = await indexer.bitcoinHolders(pool.address);
console.log(`\n${h.holders.length} holders on Solana, ${b.holders.length} on Bitcoin; in the curve ${formatUnits(h.curve, pool.divisibility)}`);

console.log('\nlive trades (Ctrl+C to stop):');
subscribeTrades(connection, (t) =>
  console.log(`  ${t.side} ${t.btcAmount} sats in ${t.pool} (${t.signature})`),
);
