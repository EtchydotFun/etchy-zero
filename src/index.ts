/**
 * @etchydotfun/rune-pool: trade real Bitcoin Runes at Solana speed, from any
 * platform. Pools of the rune-pool program: the Runes stay in a Bitcoin
 * vault no one holds the key to; trading happens on Solana against WBTC.
 *
 * - `createRunePoolClient`: read pools, prices, balances and trades; quote
 *   exactly; build buy / sell / send / withdraw instructions (Solana
 *   wallets) and signed Bitcoin-wallet trades.
 * - `createEtchyApi`: Etchy's public API and relay (Bitcoin wallets trade
 *   without SOL: they sign each order, Etchy's relay sends it).
 * - Messages, memos and math are byte for byte what the program checks.
 *
 * - `createKeeper`: the keeper ("relayer") anyone can run: Bitcoin headers,
 *   pool activations, withdrawal batches, Runes coming back (deposits).
 *   Nothing depends on Etchy being online. The vault canister's client is
 *   `@etchydotfun/rune-pool/vault` (needs @dfinity/agent).
 * - `createPoolIndexer`: a pool's trades, candles, holders on Solana and
 *   holders on Bitcoin, from the chain only.
 *
 * Etchy's fee is part of every trade (the program takes it, whoever sends
 * the trade). A platform may charge its own fee on top.
 */
export * from './api.ts';
export * from './bitcoin.ts';
export * from './client.ts';
export * from './indexer.ts';
export * from './inscription.ts';
export * from './keeper.ts';
export * from './keeper-chain.ts';
export * from './math.ts';
export * from './messages.ts';
export * from './solswap.ts';
export {
  decipherRunestone,
  encipherRunestone,
  reservedRune,
  runeCommitment,
  type Artifact,
  type Runestone,
} from './runestone.ts';
export {
  IDL,
  PROGRAM_ID,
  accountDiscriminator,
  decodeAccount,
  decodeEvent,
  errorName,
  eventsFromLogs,
  instruction,
  pda,
  poolAddressOf,
  type ProgramEvent,
} from './program.ts';
export { base58, fromHex, hex } from './borsh.ts';
