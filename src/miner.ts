import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import {
  Reader,
  Writer,
  decodeType,
  encodeType,
  type IdlLike,
} from './borsh.ts';
import { RUNE_MINER_IDL } from './miner-idl.ts';
import { instruction, pda } from './program.ts';

/**
 * M118 Mined Runes: the rune-miner program (a Zero Rune's mined share,
 * earned with proof of work one round at a time) and its math, byte for
 * byte what the program does (checked against its tests' fixture). v2: a
 * result is a HashWX nonce at the miner's own target (vardiff shares); no
 * pause (nobody can stop mining).
 */
export const MINER_IDL: IdlLike = RUNE_MINER_IDL as unknown as IdlLike;
export const MINER_PROGRAM_ID = new PublicKey(MINER_IDL.address);
export const SLOT_HASHES = new PublicKey(
  'SysvarS1otHashes111111111111111111111111111',
);
/** Rounds the mine keeps (a share of an older round can no longer be settled). */
export const MINE_RING = 128;
/** The Mine account's data after its 8-byte discriminator (zero copy). */
export const MINE_SPACE = 4536;
export const NO_ROUND = (1n << 64n) - 1n;
/** A result weighs at most 2^32 results at the round's minimum. */
export const MAX_EXTRA_BITS = 32;
export const MAX_DIFFICULTY = 64;
export const AVG_SECS = 3_600n;
export const AVG_MAX_STEP_SECS = 60n;

const enc = (s: string) => new TextEncoder().encode(s);
const find = (seeds: Uint8Array[]) =>
  PublicKey.findProgramAddressSync(seeds, MINER_PROGRAM_ID)[0];
export const minerPda = {
  /** A mined pool's mine (it owns the mined share's Zero balance). */
  mine: (pool: PublicKey) => find([enc('mine'), pool.toBytes()]),
  /** One mining key's miner. */
  miner: (mine: PublicKey, authority: PublicKey) =>
    find([enc('miner'), mine.toBytes(), authority.toBytes()]),
  /** Whose balance the mining fees buy back into (it never moves). */
  locked: (mine: PublicKey) => find([enc('locked'), mine.toBytes()]),
};

/** One rune-miner instruction from its IDL (accounts by their IDL names). */
export function minerInstruction(
  name: string,
  args: Record<string, unknown>,
  accounts: Record<string, PublicKey>,
): TransactionInstruction {
  const def = MINER_IDL.instructions.find((x) => x.name === name);
  if (!def) throw new Error(`no instruction ${name}`);
  const w = new Writer();
  w.bytes(Uint8Array.from(def.discriminator));
  for (const a of def.args) {
    if (!(a.name in args))
      throw new Error(`${name}: argument ${a.name} missing`);
    encodeType(MINER_IDL, w, a.type, args[a.name], a.name);
  }
  const keys = def.accounts.map((a) => {
    const key =
      accounts[a.name] ?? (a.address ? new PublicKey(a.address) : undefined);
    if (!key) throw new Error(`${name}: account ${a.name} missing`);
    return { pubkey: key, isSigner: !!a.signer, isWritable: !!a.writable };
  });
  return new TransactionInstruction({
    programId: MINER_PROGRAM_ID,
    keys,
    data: Buffer.from(w.done()),
  });
}

function decodeMinerAccount<T>(name: string, data: Uint8Array): T {
  const a = MINER_IDL.accounts.find((x) => x.name === name);
  if (!a || data.length < 8 || !a.discriminator.every((x, i) => data[i] === x))
    throw new Error(`not a ${name} account`);
  const r = new Reader(data);
  r.take(8);
  return decodeType(MINER_IDL, r, { defined: { name } }) as T;
}

export interface MineStep {
  /** From this market cap (sats) on ... */
  mcap: bigint;
  /** ... this many Rune units a round. */
  runesPerRound: bigint;
}
export interface MineRound {
  round: bigint;
  weight: bigint;
  budget: bigint;
  results: number;
  minDifficulty: number;
}
export interface MineState {
  pool: PublicKey;
  feeTo: PublicKey;
  start: number;
  roundSecs: number;
  feeLamports: bigint;
  /** The mined share (Rune units) and what rounds have taken. */
  cap: bigint;
  allocated: bigint;
  results: bigint;
  startMcap: bigint;
  /** The market cap average the speed reads (sats), and when it last moved. */
  mcapAvg: bigint;
  mcapAt: number;
  targetResults: bigint;
  steps: MineStep[];
  /** The next new round's minimum difficulty, and its floor. */
  minDifficulty: number;
  difficultyFloor: number;
  divisibility: number;
  rounds: MineRound[];
}
type RawMine = {
  pool: PublicKey;
  fee_to: PublicKey;
  start: bigint;
  round_secs: bigint;
  fee_lamports: bigint;
  cap: bigint;
  allocated: bigint;
  results: bigint;
  start_mcap: bigint;
  mcap_avg: bigint;
  mcap_at: bigint;
  target_results: bigint;
  steps_mcap: bigint[];
  steps_budget: bigint[];
  min_difficulty: number;
  difficulty_floor: number;
  step_count: number;
  divisibility: number;
  rounds: {
    round: bigint;
    weight: bigint;
    budget: bigint;
    results: number;
    min_difficulty: number;
  }[];
};
export function decodeMine(data: Uint8Array): MineState {
  const m = decodeMinerAccount<RawMine>('Mine', data);
  const n = Math.min(m.step_count, m.steps_mcap.length);
  return {
    pool: m.pool,
    feeTo: m.fee_to,
    start: Number(m.start),
    roundSecs: Number(m.round_secs),
    feeLamports: m.fee_lamports,
    cap: m.cap,
    allocated: m.allocated,
    results: m.results,
    startMcap: m.start_mcap,
    mcapAvg: m.mcap_avg,
    mcapAt: Number(m.mcap_at),
    targetResults: m.target_results,
    steps: Array.from({ length: n }, (_, i) => ({
      mcap: m.steps_mcap[i],
      runesPerRound: m.steps_budget[i],
    })),
    minDifficulty: m.min_difficulty,
    difficultyFloor: m.difficulty_floor,
    divisibility: m.divisibility,
    rounds: m.rounds.map((r) => ({
      round: r.round,
      weight: r.weight,
      budget: r.budget,
      results: r.results,
      minDifficulty: r.min_difficulty,
    })),
  };
}

export interface MinerState {
  mine: PublicKey;
  authority: PublicKey;
  owner: PublicKey;
  /** The next result must solve this (changes after every result). */
  challenge: Uint8Array;
  /** Its last result's round (null: settled) and weight. */
  pendingRound: bigint | null;
  pendingWeight: bigint;
  /** Settled, not sent yet; everything settled so far. */
  unclaimed: bigint;
  earned: bigint;
  results: bigint;
  best: number;
  openedAt: number;
  /** Its target difficulty now (vardiff), and its last result's round (null: none). */
  target: number;
  lastRound: bigint | null;
}
export function decodeMiner(data: Uint8Array): MinerState {
  const x = decodeMinerAccount<{
    mine: PublicKey;
    authority: PublicKey;
    owner: PublicKey;
    challenge: Uint8Array;
    pending_round: bigint;
    pending_weight: bigint;
    unclaimed: bigint;
    earned: bigint;
    results: bigint;
    best: number;
    opened_at: bigint;
    target: number;
    last_round: bigint;
  }>('Miner', data);
  return {
    mine: x.mine,
    authority: x.authority,
    owner: x.owner,
    challenge: x.challenge,
    pendingRound: x.pending_round === NO_ROUND ? null : x.pending_round,
    pendingWeight: x.pending_weight,
    unclaimed: x.unclaimed,
    earned: x.earned,
    results: x.results,
    best: x.best,
    openedAt: Number(x.opened_at),
    target: x.target,
    lastRound: x.last_round === NO_ROUND ? null : x.last_round,
  };
}
/** Where a Miner account's owner sits (account filters). */
export const MINER_OWNER_OFFSET = 8 + 1 + 1 + 32 + 32;
export const MINER_MINE_OFFSET = 8 + 1 + 1;

// ---------------------------------------------------------------- the rules (the program's)
/** The round `now` (unix seconds) is in; null before the start. */
export function roundAt(m: MineState, now: number): bigint | null {
  if (now < m.start) return null;
  return BigInt(Math.floor((now - m.start) / Math.max(1, m.roundSecs)));
}
/** When a round starts (unix seconds). */
export const roundStart = (m: MineState, round: bigint) =>
  m.start + Number(round) * m.roundSecs;
/** Runes a new round shares at a market cap average (the speed table). */
export function speedAt(m: MineState, mcapAvg: bigint = m.mcapAvg): bigint {
  let b = m.steps[0]?.runesPerRound ?? 0n;
  for (let i = 1; i < m.steps.length; i++)
    if (mcapAvg >= m.steps[i].mcap) b = m.steps[i].runesPerRound;
  return b;
}
/** The average after an update at `now` with market cap `mcap`. */
export function observe(m: MineState, mcap: bigint, now: number): bigint {
  const dt = BigInt(now - m.mcapAt);
  if (dt <= 0n) return m.mcapAvg;
  const step = dt < AVG_MAX_STEP_SECS ? dt : AVG_MAX_STEP_SECS;
  const next = m.mcapAvg + ((mcap - m.mcapAvg) * step) / AVG_SECS;
  return next < 0n ? 0n : next;
}
/** The pool's market cap (sats): its price times the whole supply. */
export function mcapOf(p: {
  supply: bigint;
  reserves: { btcReal: bigint; btcVirtual: bigint; rune: bigint };
}): bigint {
  if (p.reserves.rune <= 0n) return (1n << 64n) - 1n;
  return (
    ((p.reserves.btcReal + p.reserves.btcVirtual) * p.supply) / p.reserves.rune
  );
}
/** A round's slot as the mine holds it (null: not opened yet). */
export function roundOf(m: MineState, round: bigint): MineRound | null {
  const r = m.rounds[Number(round % BigInt(MINE_RING))];
  return r && r.round === round ? r : null;
}
/**
 * The minimum difficulty of `round`: fixed once its first result opened it;
 * else what its first result will set (from the round before's results).
 */
export function minDifficultyOf(m: MineState, round: bigint): number {
  const open = roundOf(m, round);
  if (open) return open.minDifficulty;
  const prev = round > 0n ? roundOf(m, round - 1n) : null;
  const n = round > 0n ? BigInt(prev?.results ?? 0) : m.targetResults;
  if (n > m.targetResults) return Math.min(64, m.minDifficulty + 1);
  if (n * 4n < m.targetResults)
    return Math.max(m.difficultyFloor, m.minDifficulty - 1);
  return m.minDifficulty;
}
/**
 * A share's weight: a result at the miner's `target` in a round with
 * minimum `min` (a target under the minimum counts at the minimum).
 */
export function weightOf(target: number, min: number): bigint {
  return 1n << BigInt(Math.min(Math.max(target, min) - min, MAX_EXTRA_BITS));
}
/** The difficulty a miner's next result needs in a round with minimum `min`. */
export const neededOf = (target: number, min: number) => Math.max(target, min);
/**
 * Vardiff (the program's `next_target`): after a result `gap` rounds after
 * the last (0: the first), one higher if the gap is 1, lower if 3 or more.
 */
export function nextTargetOf(target: number, gap: bigint, floor: number) {
  if (gap === 1n) return Math.min(MAX_DIFFICULTY, target + 1);
  if (gap >= 3n) {
    const log2 = gap.toString(2).length - 1;
    const down = Math.max(1, log2 - 1);
    return Math.max(floor, target - down);
  }
  return target;
}
/**
 * A miner's share of its last round: settled (`final`) once the round is
 * over, else what it gets if no more results come (it can only shrink).
 * Null: nothing pending, or its round is gone.
 */
export function pendingShare(
  m: MineState,
  x: MinerState,
  nowRound: bigint | null,
): { runes: bigint; final: boolean } | null {
  if (x.pendingRound === null) return null;
  const r = roundOf(m, x.pendingRound);
  if (!r || r.weight <= 0n) return null;
  return {
    runes: (r.budget * x.pendingWeight) / r.weight,
    final: nowRound !== null && x.pendingRound < nowRound,
  };
}
/** Left to mine (Rune units), and the rounds it lasts at the current speed. */
export function mineLeft(m: MineState) {
  const left = m.cap > m.allocated ? m.cap - m.allocated : 0n;
  const speed = speedAt(m);
  return { left, rounds: speed > 0n ? left / speed : 0n };
}

// ---------------------------------------------------------------- instructions
export interface MineArgs {
  start: number;
  roundSecs: number;
  feeLamports: bigint;
  feeTo: PublicKey;
  targetResults: number;
  minDifficulty: number;
  difficultyFloor: number;
  steps: MineStep[];
}
/** Zero's admin: the mine of a mined launch pool. */
export function createMineIx(p: {
  admin: PublicKey;
  pool: PublicKey;
  args: MineArgs;
}) {
  const mine = minerPda.mine(p.pool);
  return minerInstruction(
    'create_mine',
    {
      args: {
        start: BigInt(p.args.start),
        round_secs: p.args.roundSecs,
        fee_lamports: p.args.feeLamports,
        fee_to: p.args.feeTo,
        target_results: p.args.targetResults,
        min_difficulty: p.args.minDifficulty,
        difficulty_floor: p.args.difficultyFloor,
        steps: p.args.steps.map((s) => ({
          mcap: s.mcap,
          runes_per_round: s.runesPerRound,
        })),
      },
    },
    {
      admin: p.admin,
      zero_config: pda.config(),
      pool: p.pool,
      mine_balance: pda.balance(p.pool, mine),
      mine,
    },
  );
}
/** Zero's admin: a launch pool whose curve starts with `supply - mined` (rune_pool). */
export function createMinedLaunchPoolIx(p: {
  admin: PublicKey;
  quoteMint: PublicKey;
  args: Record<string, unknown> & { rune_block: bigint; rune_tx: number };
  launchKey: Uint8Array;
  mined: bigint;
}) {
  const pool = pda.pool(Number(p.args.rune_block), p.args.rune_tx);
  const mine = minerPda.mine(pool);
  return instruction(
    'create_mined_launch_pool',
    { args: p.args, launch_key: p.launchKey, mined: p.mined },
    {
      admin: p.admin,
      config: pda.config(),
      quote_mint: p.quoteMint,
      pool,
      vault: pda.vault(pool),
      launch: pda.launch(p.launchKey),
      mine,
      mine_balance: pda.balance(pool, mine),
    },
  );
}
/**
 * The mining key opens its miner (pays its rent); the Runes go to `owner`;
 * `target`: its first target difficulty (from the computer's speed).
 */
export function openMinerIx(p: {
  pool: PublicKey;
  authority: PublicKey;
  owner: PublicKey;
  target: number;
}) {
  const mine = minerPda.mine(p.pool);
  return minerInstruction(
    'open_miner',
    { owner: p.owner, target: p.target },
    {
      authority: p.authority,
      mine,
      miner: minerPda.miner(mine, p.authority),
      slot_hashes: SLOT_HASHES,
    },
  );
}
/** One result: a HashWX nonce (signed and paid by the mining key). */
export function mineIx(p: {
  pool: PublicKey;
  authority: PublicKey;
  feeTo: PublicKey;
  nonce: bigint;
}) {
  const mine = minerPda.mine(p.pool);
  return minerInstruction(
    'mine',
    { nonce: p.nonce },
    {
      authority: p.authority,
      mine,
      miner: minerPda.miner(mine, p.authority),
      fee_to: p.feeTo,
      pool: p.pool,
    },
  );
}
/** Anyone: the miner's settled Runes to its owner's Zero balance (`payer` pays a new balance's rent). */
export function claimIx(p: {
  pool: PublicKey;
  authority: PublicKey;
  owner: PublicKey;
  payer: PublicKey;
}) {
  const mine = minerPda.mine(p.pool);
  return minerInstruction(
    'claim',
    {},
    {
      payer: p.payer,
      mine,
      miner: minerPda.miner(mine, p.authority),
      owner: p.owner,
      pool: p.pool,
      mine_balance: pda.balance(p.pool, mine),
      owner_balance: pda.balance(p.pool, p.owner),
    },
  );
}
/** Anyone: moves the market cap average toward the pool's price now. */
export function pokeIx(pool: PublicKey) {
  return minerInstruction('poke', {}, { mine: minerPda.mine(pool), pool });
}
/** The mining key, once everything is claimed: closes its miner (rent back). */
export function closeMinerIx(p: { pool: PublicKey; authority: PublicKey }) {
  const mine = minerPda.mine(p.pool);
  return minerInstruction(
    'close_miner',
    {},
    { authority: p.authority, miner: minerPda.miner(mine, p.authority) },
  );
}
