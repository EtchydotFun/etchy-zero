/**
 * Everything a site, bot or terminal can read from Etchy's public pool API,
 * with no key and no wallet: pools, trade history (paged), market cap
 * candles, holders in the pool and on Bitcoin, 24h stats, fee rewards, a
 * wallet's balances and withdrawals, then live trades for 30 seconds.
 *
 *   node --experimental-strip-types examples/read-api.ts [Rune ID or name] [wallet]
 */
import { createEtchyApi, formatUnits } from '../src/index.ts';

const api = createEtchyApi(
  process.env.ETCHY_POOL_API ?? 'https://api.etchy.fun/rune-pools',
);
const which = process.argv[2] ?? '971505:1052';
const wallet = process.argv[3];

const pools = await api.pools({ sort: 'volume' });
console.log(`${pools.length} pools`);
for (const p of pools)
  console.log(
    `  ${p.runeId.padEnd(12)} ${p.runeName.padEnd(30)} ${p.marketCapBtc.toFixed(5)} BTC  ${p.stats?.holders ?? '?'} holders  ${p.stats?.trades24h ?? '?'} trades 24h`,
  );

const pool = await api.pool(which);
const d = pool.divisibility;
const unit = pool.meta?.ticker ?? pool.runeName;
console.log(`\n${pool.runeName} (${pool.runeId}), pool ${pool.pool}`);
if (pool.meta?.logo) console.log(`logo: ${api.url(pool.meta.logo)}`);

// Trade history: newest first, 20 a page; `next` reads older ones.
const page = await api.tradesPage(pool.pool, { limit: 20 });
console.log(`\n${page.total} trades; latest:`);
for (const t of page.trades.slice(0, 10))
  console.log(
    `  ${t.time ? new Date(t.time * 1000).toISOString() : '?'} ${t.side.padEnd(4)} ${formatUnits(BigInt(t.runeAmount), d)} ${unit} for ${t.btcAmount} sats by ${t.ownerBitcoin ?? t.owner}`,
  );
if (page.next) {
  const older = await api.tradesPage(pool.pool, {
    limit: 20,
    before: page.next,
  });
  console.log(`  (+ ${older.trades.length} older on the next page)`);
}

const chart = await api.candles(pool.pool, '1h', 24);
console.log(
  `\nmarket cap now ${chart.now.marketCapBtc.toFixed(5)} BTC${chart.now.marketCapUsd === null ? '' : ` ($${chart.now.marketCapUsd.toFixed(0)})`}; ${chart.btc.length} hourly candles`,
);

const holders = await api.holders(pool.pool);
console.log(
  `\ntop holders in the pool (curve holds ${formatUnits(BigInt(holders.curve), d)}):`,
);
for (const h of holders.holders.slice(0, 5))
  console.log(
    `  ${h.bitcoinAddress ?? h.owner} ${formatUnits(BigInt(h.amount), d)}`,
  );
const onBitcoin = await api.bitcoinHolders(pool.pool);
console.log(
  `on Bitcoin: ${onBitcoin.holders.length} addresses, ${formatUnits(BigInt(onBitcoin.total), d)} ${unit}`,
);

const stats = await api.stats(pool.pool);
console.log(
  `\n24h: ${stats.trades24h} trades (${stats.buys24h} buys, ${stats.sells24h} sells), ${stats.volume24hSats} sats, ${stats.change24hPct.toFixed(1)}%`,
);
const rewards = await api.rewards(pool.pool);
console.log(
  rewards.fees
    ? `fee rewards (${rewards.fees}): paid ${rewards.paidSats} sats, owed ${rewards.owedSats}, next round ${rewards.nextRoundAt}`
    : 'no fee rewards on this pool',
);

if (wallet) {
  const b = await api.balances(wallet);
  console.log(`\n${wallet}: WBTC ${b.wbtc ?? 0} sats`);
  for (const x of b.balances) console.log(`  ${x.name} ${x.amount}`);
  for (const w of await api.withdrawals(wallet))
    console.log(
      `  withdrawal ${w.id}: ${w.amount} to ${w.to}, ${w.status}${w.txid ? ` (${w.txid})` : ''}`,
    );
}

console.log('\nlive trades for 30 s...');
const live = api.stream(
  (t) => console.log(`  LIVE ${t.side} ${t.btcAmount} sats (${t.id})`),
  { pool: pool.pool },
);
setTimeout(() => live.close(), 30_000);
