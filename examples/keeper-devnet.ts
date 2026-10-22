/**
 * Run your own keeper (devnet): no Etchy server, no Etchy key. It follows
 * Bitcoin (mempool.space), keeps the Solana Bitcoin relay up to date, opens
 * pools whose Runes were etched, has the vault canister open vaults, start
 * and pay withdrawal batches (the canister signs and sends them itself;
 * strangers get a few calls per pool per hour, plenty for this), proves the
 * payouts, and credits Runes sent back to a pool (deposits).
 *
 * Every step is checked by the program or the canister, so a keeper can
 * only help: it cannot move anything. Etchy runs the same code; if Etchy is
 * offline, anyone running this keeps every pool working.
 *
 *   node --experimental-strip-types rune-pool/sdk/examples/keeper-devnet.ts <devnet key.json> [once]
 *
 * The key pays devnet fees, and while a named Rune's pool opens, the rent of
 * its proof buffer (about 0.3 SOL, back when it closes).
 */
import { readFileSync } from 'node:fs';
import { Connection, Keypair } from '@solana/web3.js';
import { createKeeper, DEVNET_LOOKUP_TABLE } from '../src/index.ts';
import { createVaultCanister, keeperVault } from '../src/vault.ts';

const file = process.argv[2];
if (!file) throw new Error('usage: keeper-devnet.ts <devnet key.json> [once]');
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(file, 'utf8')) as number[]),
);
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
// Anonymous: the canister's public methods (rate-limited per pool).
const canister = await createVaultCanister();
const s = await canister.status();
console.log(
  `canister ${s.version}${s.paused ? ' (PAUSED)' : ''}: public limits ${s.public_limits.per_pool_per_hour}/pool/hour, ${s.public_limits.per_hour}/hour`,
);
const keeper = createKeeper({
  connection,
  payer,
  vault: keeperVault(canister),
  lookupTable: DEVNET_LOOKUP_TABLE,
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
});
console.log(
  `keeper ${payer.publicKey.toBase58()}: ${(await connection.getBalance(payer.publicKey)) / 1e9} devnet SOL`,
);
if (process.argv[3] === 'once') {
  await keeper.tick();
} else {
  let busy = false;
  const run = () => {
    if (busy) return;
    busy = true;
    keeper
      .tick()
      .catch((e) =>
        console.log(`tick: ${String((e as Error).message ?? e).slice(0, 300)}`),
      )
      .finally(() => (busy = false));
  };
  run();
  setInterval(run, 60_000);
}
