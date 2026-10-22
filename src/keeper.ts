/**
 * The pool keeper ("relayer"): keeps the rune-pool program moving with
 * Bitcoin, from on-chain state only. ANYONE can run one, so nothing depends
 * on Etchy staying online: it holds no vault key
 * and needs no permission; the program checks every proof and the vault
 * canister signs only what the program's state asks for. It only needs a
 * Solana key with a little SOL for the fees (`createKeeper`, keeper-node.ts).
 * Each tick:
 *
 *  1. Headers: new Bitcoin block headers into the btc-relay program (from a
 *     few blocks back, so a short reorg is followed too; known ones are
 *     skipped by the program). After a reorg, from where the relay's chain
 *     and Bitcoin's part; a branch longer than one transaction holds goes
 *     in at once from a proof buffer (`submit_headers_from`).
 *  2. Per pool whose vault is the canister's (asked once, remembered):
 *     - a PENDING launch pool without a vault: the canister signs
 *       `open_vault` (its launch key's address), the relayer sends it;
 *     - a PENDING pool with its vault: its etching (block `rune_block`,
 *       index `rune_tx`) proven with enough confirmations: `activate_by_proof`;
 *     - waiting withdrawals and no batch: the canister signs `start_batch`;
 *     - an open batch: the canister pays it on Bitcoin (`pay_batch`; asked
 *       again it re-sends the same transaction, or a fee bump once fees rose
 *       and an hour passed); once the vault coin's spend has enough
 *       confirmations: `prove_vault_spend` with the batch's withdrawals and
 *       the deposit coins it swept.
 *     - a named Rune (a chosen name, not the reserved one): its activation
 *       needs the name's commitment proven (`activate_named`, a proof
 *       buffer written in chunks).
 *  3. Runes coming back (deposits), per active pool:
 *     - delivered withdrawals: their Bitcoin output becomes a known coin
 *       (`register_withdrawal_coin`);
 *     - a known coin spent on Bitcoin (a transfer, a sale), confirmed:
 *       `prove_coin_spend` with every known coin that transaction spends and
 *       the outputs that get Runes (ord's allocation, as the program runs
 *       it). An output at the vault address is a deposit, owned by the memo's
 *       Solana key;
 *     - a deposit with an owner: `credit_deposit` (its Runes in the owner's
 *       pool balance).
 *
 * Failures wait (retry later) and never repeat a canister call in a loop.
 * Pure logic: the chain, Bitcoin, the vault canister and the store are passed in.
 */
import { displayTxid, sha256d } from './bitcoin.ts';
import { hex } from './borsh.ts';
import { decipherRunestone, reservedRune, type Artifact } from './runestone.ts';

export const M83_POOL_RELAYER_POLICY = Object.freeze({
  /** Headers per tick at most (catch-up), sent 12 per transaction. */
  headersPerTick: 96,
  headerBatch: 12,
  /** Re-send this many known headers before the new ones (short reorgs). */
  reorgDepth: 6,
  /** btc-relay's MAX_REORG: the deepest fork it takes. */
  maxReorg: 24,
  /** btc-relay's MAX_FROM: headers in one `submit_headers_from`. */
  headersFromAtOnce: 64,
  minFeeRate: 1,
  /** Below the canister's own cap (100 sat/vB). */
  maxFeeRate: 50,
  /** A batch transaction unconfirmed this long may be fee-bumped. */
  bumpAfterSeconds: 3_600,
  /** After pay_batch, give mempool sources this long to see it. */
  seenAfterSeconds: 180,
  /** After a failure, wait this long before trying that pool again. */
  retrySeconds: 600,
  /** Deposit actions (register, prove, credit) per pool per tick. */
  depositActionsPerTick: 6,
  /** Known coins checked on Bitcoin per pool per tick (round robin). */
  coinChecksPerTick: 25,
  /** The program's limits of `prove_coin_spend` (every input counts). */
  maxCoinInputs: 12,
  maxCoinOutputs: 8,
});
export type M83PoolRelayerPolicy = typeof M83_POOL_RELAYER_POLICY;

const POOL_PENDING = 0;

export interface RelayerVault {
  /** The vault output script (hex). */
  script: string;
  hasCoin: boolean;
  /** Display order (as explorers show it). */
  coinTxid: string;
  coinVout: number;
  batch: bigint;
  pending: bigint;
  alarm: boolean;
  batchSweeps: number;
}
export interface RelayerPool {
  pool: string;
  status: number;
  runeBlock: bigint;
  runeTx: number;
  /** The Rune's name (base-26 value): a chosen name unless it is the reserved one. */
  runeName: bigint;
  /** Hex; null for pools made without one. */
  launchKey: string | null;
  vault: RelayerVault | null;
}
export interface RelayerProof {
  txid: Uint8Array;
  height: number;
  rawTx: Uint8Array;
  index: number;
  branch: Uint8Array[];
  /**
   * The block's coinbase (no witness) and its branch, when a level of
   * `branch` is shaped like a 64-byte transaction (bitcoin.ts
   * `branchShaped`): the program then needs the block's depth, so the
   * proof goes through a buffer.
   */
  coinbase?: { rawTx: Uint8Array; branch: Uint8Array[] };
}
/** A Bitcoin output the program knows holds the pool's Rune (`KnownCoin`). */
export interface RelayerCoin {
  /** The record's Solana address. */
  address: string;
  /** Display order. */
  txid: string;
  vout: number;
  runes: bigint;
  /** At the vault address (a deposit), else a free coin. */
  deposit: boolean;
  /** Deposits: the memo's owner (null: none). */
  owner: string | null;
  credited: boolean;
}
/** `activate_named`'s proof (named.rs `NamedProof` payload). */
export interface RelayerNamedProof {
  payload: Uint8Array;
  commitHeight: number;
  commitIndex: number;
}
export interface PoolRelayerChain {
  relayTip(): Promise<number>;
  /** The relay's block hash at `height` (display order); null if it has none. */
  relayHash(height: number): Promise<string | null>;
  submitHeaders(headers: Uint8Array[]): Promise<string>;
  /**
   * Headers in ONE instruction, more than a transaction holds (a fork
   * deeper than about 11 blocks must win at once): written to a proof
   * buffer, `submit_headers_from` reads them there.
   */
  submitHeadersFrom(headers: Uint8Array[]): Promise<string>;
  minConfirmations(): Promise<number>;
  pools(): Promise<RelayerPool[]>;
  /** Ids of the withdrawals in this batch, increasing. */
  batchIds(pool: string, batch: bigint): Promise<bigint[]>;
  activate(pool: string, proof: RelayerProof): Promise<string>;
  /** Writes the proof into a buffer, `activate_named`, closes the buffer. */
  activateNamed(pool: string, proof: RelayerNamedProof): Promise<string>;
  /**
   * `inputs`: every input of the transaction except the vault coin, in
   * order (display txid); the program accounts for each one.
   */
  proveVaultSpend(
    pool: string,
    proof: RelayerProof,
    ids: bigint[],
    inputs: { txid: string; vout: number }[],
  ): Promise<string>;
  /** Delivered withdrawals whose Bitcoin output is not a known coin yet. */
  unregistered(pool: string): Promise<bigint[]>;
  registerCoin(pool: string, id: bigint): Promise<string>;
  coins(pool: string): Promise<RelayerCoin[]>;
  /** This transaction was already proven for this pool (`ProvenTx`). */
  proven(pool: string, txid: string): Promise<boolean>;
  /**
   * `inputs`: EVERY input of the transaction, in order (display txid; the
   * program counts the known ones, each once); `outputs`: vouts that get
   * Runes, increasing.
   */
  proveCoinSpend(
    pool: string,
    proof: RelayerProof,
    inputs: { txid: string; vout: number }[],
    outputs: number[],
  ): Promise<string>;
  creditDeposit(pool: string, coin: RelayerCoin): Promise<string>;
}
export interface PoolRelayerBitcoin {
  tip(): Promise<number>;
  /** Raw 80-byte headers `from..=to`, linked. */
  headers(from: number, to: number): Promise<Uint8Array[]>;
  /** Display txid of the transaction at `index` in block `height`. */
  txidAt(height: number, index: number): Promise<string>;
  /** Who spent this output (null: unspent); height null: in the mempool. */
  spender(
    txid: string,
    vout: number,
  ): Promise<{ txid: string; height: number | null } | null>;
  /** The proof of a confirmed transaction; null: not confirmed. */
  prove(txid: string): Promise<RelayerProof | null>;
  /** Sat/vB for confirmation within about half an hour. */
  feeRate(): Promise<number>;
  /** The proof that this confirmed etching committed to `rune` (null: not found). */
  namedProof(etchTxid: string, rune: bigint): Promise<RelayerNamedProof | null>;
}
/**
 * The vault canister (vault.ts): anyone may ask it (it picks the blockhash
 * and the Bitcoin fee rate itself and sends what it signs).
 */
export interface PoolRelayerVault {
  /** The pool's vault output script (hex) as the canister derives it. */
  vaultScript(pool: string): Promise<string>;
  /** `open_vault` for a PENDING launch pool, sent: its Solana signature. */
  openVault(pool: string): Promise<string>;
  /** `start_batch` with the oldest pending withdrawals, sent: its signature. */
  startBatch(pool: string): Promise<string>;
  /** Pays the final batch on Bitcoin (`feeRate`: the keeper's reading; a
   * public call lets the canister read its own). */
  payBatch(
    pool: string,
    feeRate: number,
  ): Promise<{ txid: string; feeRate: number; version: number }>;
}
export interface RelayerRecord {
  /** The vault is (true) or is not (false) this canister's; unknown if absent. */
  ours?: boolean;
  retryAt?: number;
  lastError?: string;
  /** A batch: when it was last paid, at what rate, every txid signed. */
  paidAt?: number;
  rate?: number;
  txids?: string[];
  /** A Bitcoin transaction that cannot be proven (too many inputs/outputs, proven before). */
  stuck?: boolean;
}

// ---------------------------------------------------------------- ord, for one Rune

/** Inputs (display txid) and output scripts of a raw transaction (with or without witness). */
export function txBasics(raw: Uint8Array): {
  inputs: { txid: string; vout: number }[];
  outputs: Uint8Array[];
} {
  let at = 4;
  if (raw[4] === 0 && raw[5] === 1) at = 6;
  const need = (n: number) => {
    if (at + n > raw.length) throw new Error('truncated transaction');
  };
  const varint = () => {
    need(1);
    const f = raw[at++];
    if (f < 0xfd) return f;
    const n = f === 0xfd ? 2 : f === 0xfe ? 4 : 8;
    need(n);
    let v = 0;
    for (let i = n - 1; i >= 0; i--) v = v * 256 + raw[at + i];
    at += n;
    return v;
  };
  const u32 = () => {
    need(4);
    const v =
      (raw[at] | (raw[at + 1] << 8) | (raw[at + 2] << 16)) +
      raw[at + 3] * 0x1000000;
    at += 4;
    return v;
  };
  const inputs: { txid: string; vout: number }[] = [];
  for (let i = 0, n = varint(); i < n; i++) {
    need(32);
    const txid = hex(Uint8Array.from(raw.subarray(at, at + 32)).reverse());
    at += 32;
    const vout = u32();
    const len = varint();
    need(len + 4);
    at += len + 4;
    inputs.push({ txid, vout });
  }
  const outputs: Uint8Array[] = [];
  for (let i = 0, n = varint(); i < n; i++) {
    need(8);
    at += 8;
    const len = varint();
    need(len);
    outputs.push(raw.subarray(at, at + len));
    at += len;
  }
  return { inputs, outputs };
}

const isOpReturn = (s: Uint8Array) => s[0] === 0x6a;

/**
 * Where one Rune's `units` go in a transaction with these outputs: a port
 * of rune-core `allocate` (ord's `index_runes` for one Rune, no etching, no
 * mint), byte for byte what `prove_coin_spend` computes.
 */
export function allocateRune(
  outputs: Uint8Array[],
  artifact: Artifact | null,
  id: { block: bigint; tx: bigint },
  units: bigint,
): bigint[] {
  const n = outputs.length;
  if (n === 0) throw new Error('no outputs');
  const out = outputs.map(() => 0n);
  let balance = units;
  if (artifact?.kind === 'runestone') {
    for (const e of artifact.runestone.edicts) {
      if (e.id.block !== id.block || e.id.tx !== id.tx) continue;
      const o = Number(e.output);
      if (o === n) {
        const dest = outputs
          .map((s, i) => (isOpReturn(s) ? -1 : i))
          .filter((i) => i >= 0);
        if (!dest.length) continue;
        if (e.amount === 0n) {
          const len = BigInt(dest.length);
          const each = balance / len;
          const rem = Number(balance % len);
          dest.forEach((d, i) => {
            const a = i < rem ? each + 1n : each;
            balance -= a;
            out[d] += a;
          });
        } else {
          for (const d of dest) {
            const a = e.amount < balance ? e.amount : balance;
            balance -= a;
            out[d] += a;
          }
        }
      } else {
        const a = e.amount === 0n || e.amount > balance ? balance : e.amount;
        balance -= a;
        out[o] += a;
      }
    }
  }
  if (artifact?.kind !== 'cenotaph') {
    const pointer =
      artifact?.kind === 'runestone' ? artifact.runestone.pointer : undefined;
    const v =
      pointer !== undefined
        ? Number(pointer)
        : outputs.findIndex((s) => !isOpReturn(s));
    if (v >= 0 && balance > 0n) out[v] += balance;
  }
  return out.map((u, i) => (isOpReturn(outputs[i]) ? 0n : u));
}
export interface PoolRelayerStore {
  get(key: string): Promise<RelayerRecord | null>;
  put(key: string, rec: RelayerRecord): Promise<void>;
}

const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

export function createPoolRelayer(d: {
  chain: PoolRelayerChain;
  bitcoin: PoolRelayerBitcoin;
  vault: PoolRelayerVault;
  store: PoolRelayerStore;
  now?: () => number;
  log?: (line: string) => void;
  policy?: M83PoolRelayerPolicy;
}) {
  const p = d.policy ?? M83_POOL_RELAYER_POLICY;
  const now = d.now ?? (() => Math.floor(Date.now() / 1000));
  const log = d.log ?? (() => {});
  const short = (k: string) => `${k.slice(0, 6)}..`;

  /** Bitcoin's block hash at `height` (display order), from its header. */
  async function bitcoinHash(height: number): Promise<string> {
    const [h] = await d.bitcoin.headers(height, height);
    return displayTxid(await sha256d(h));
  }

  async function syncHeaders(): Promise<number> {
    const [tip, btcTip] = await Promise.all([
      d.chain.relayTip(),
      d.bitcoin.tip(),
    ]);
    if (btcTip <= tip) return tip;
    // Where the relay's chain and Bitcoin's part (a reorg): the highest
    // block both have.
    const lowest = Math.max(1, tip - p.maxReorg);
    let fork = tip;
    while (fork >= lowest) {
      const [mine, theirs] = await Promise.all([
        d.chain.relayHash(fork),
        bitcoinHash(fork),
      ]);
      if (mine !== null && mine === theirs) break;
      fork--;
    }
    if (fork < lowest)
      throw new Error(
        `the relay's chain parts from Bitcoin's more than ${p.maxReorg} blocks back: nothing a keeper can do`,
      );
    const replaced = tip - fork;
    if (replaced >= p.headerBatch) {
      // Deeper than one transaction holds: the whole branch at once.
      const n = Math.min(btcTip - fork, p.headersFromAtOnce);
      if (n <= replaced) return tip; // Bitcoin's branch is not longer yet
      const hs = await d.bitcoin.headers(fork + 1, fork + n);
      await d.chain.submitHeadersFrom(hs);
      const after = await d.chain.relayTip();
      log(
        `headers: reorg of ${replaced} block(s) from ${fork}: relay ${tip} -> ${after} (Bitcoin ${btcTip})`,
      );
      return after;
    }
    const from = Math.max(1, Math.min(fork + 1, tip - p.reorgDepth + 1));
    const to = Math.min(btcTip, tip + p.headersPerTick);
    const hs = await d.bitcoin.headers(from, to);
    for (let i = 0; i < hs.length; i += p.headerBatch)
      await d.chain.submitHeaders(hs.slice(i, i + p.headerBatch));
    const after = await d.chain.relayTip();
    log(
      `headers: relay ${tip} -> ${after} (Bitcoin ${btcTip})${replaced ? `, reorg of ${replaced} block(s)` : ''}`,
    );
    return after;
  }

  const rate = async () =>
    Math.min(
      p.maxFeeRate,
      Math.max(p.minFeeRate, Math.ceil(await d.bitcoin.feeRate())),
    );

  /** One pool: at most one action per tick. */
  async function step(
    pool: RelayerPool,
    tip: number,
    minConf: number,
  ): Promise<void> {
    const key = `pool:${pool.pool}`;
    const rec = (await d.store.get(key)) ?? {};
    if (rec.ours === false) return;
    if (rec.retryAt && now() < rec.retryAt) return;
    const name = short(pool.pool);
    const v = pool.vault;

    if (!v) {
      if (pool.status !== POOL_PENDING || !pool.launchKey) return;
      const sig = await d.vault.openVault(pool.pool);
      log(`${name}: vault opened (launch key) ${sig}`);
      return;
    }
    if (rec.ours === undefined) {
      rec.ours = (await d.vault.vaultScript(pool.pool)) === v.script;
      await d.store.put(key, rec);
      log(
        `${name}: vault ${rec.ours ? "is the canister's" : "is NOT the canister's: skipped"}`,
      );
      if (!rec.ours) return;
    }
    if (v.alarm) return;

    if (!v.hasCoin) {
      if (pool.status !== POOL_PENDING) return;
      if (tip - Number(pool.runeBlock) + 1 < minConf) return;
      const txid = await d.bitcoin.txidAt(Number(pool.runeBlock), pool.runeTx);
      const named =
        pool.runeName !== reservedRune(pool.runeBlock, BigInt(pool.runeTx));
      if (named) {
        const np = await d.bitcoin.namedProof(txid, pool.runeName);
        if (!np) throw new Error(`no name commitment found for ${txid}`);
        const sig = await d.chain.activateNamed(pool.pool, np);
        log(
          `${name}: activated by the proof of its etching ${txid} and its name's commitment (commit at ${np.commitHeight}:${np.commitIndex}, ${np.payload.length}-byte proof) (${sig})`,
        );
        return;
      }
      const proof = await d.bitcoin.prove(txid);
      if (!proof) return;
      const sig = await d.chain.activate(pool.pool, proof);
      log(`${name}: activated by the proof of its etching ${txid} (${sig})`);
      return;
    }

    if (v.batch === 0n) {
      if (v.pending === 0n) return;
      const sig = await d.vault.startBatch(pool.pool);
      log(`${name}: batch started ${sig}`);
      return;
    }

    const bkey = `batch:${pool.pool}:${v.batch}`;
    const b = (await d.store.get(bkey)) ?? {};
    const spent = await d.bitcoin.spender(v.coinTxid, v.coinVout);
    if (spent && spent.height !== null) {
      if (tip - spent.height + 1 < minConf) return;
      const proof = await d.bitcoin.prove(spent.txid);
      if (!proof) return;
      const ids = await d.chain.batchIds(pool.pool, v.batch);
      // Every input but the vault coin (the deposits the canister swept,
      // its fee coins): the program accounts for each one.
      const ins = txBasics(proof.rawTx).inputs;
      const others = ins.filter(
        (i) => !(i.txid === v.coinTxid && i.vout === v.coinVout),
      );
      const sweeps = (await d.chain.coins(pool.pool)).filter(
        (c) =>
          c.deposit && ins.some((i) => i.txid === c.txid && i.vout === c.vout),
      );
      const sig = await d.chain.proveVaultSpend(pool.pool, proof, ids, others);
      log(
        `${name}: batch ${v.batch} proven on Bitcoin (${spent.txid}): ${ids.length} withdrawal(s)${sweeps.length ? `, ${sweeps.length} deposit(s) swept` : ''} (${sig})`,
      );
      return;
    }
    const t = now();
    const r = await rate();
    if (spent) {
      // In the mempool: a fee bump once it waited long and fees rose 25%.
      if (!b.paidAt || t < b.paidAt + p.bumpAfterSeconds) return;
      if (r * 4 < (b.rate ?? 0) * 5) return;
    } else if (b.paidAt && t < b.paidAt + p.seenAfterSeconds) return;
    // Not seen anywhere (first time, or dropped): the canister sends the
    // same transaction again, or a bump if `r` is 25% above the last rate.
    const paid = await d.vault.payBatch(pool.pool, r);
    await d.store.put(bkey, {
      paidAt: t,
      rate: paid.feeRate,
      txids: [...new Set([...(b.txids ?? []), paid.txid])],
    });
    log(
      `${name}: batch ${v.batch} paid on Bitcoin ${paid.txid} (v${paid.version}, ${paid.feeRate} sat/vB)`,
    );
  }

  const cursors = new Map<string, number>();

  /** Runes coming back from Bitcoin (one pool, a few actions). */
  async function deposits(
    pool: RelayerPool,
    tip: number,
    minConf: number,
  ): Promise<void> {
    const name = short(pool.pool);
    const v = pool.vault;
    if (!v || v.alarm || pool.status === POOL_PENDING) return;
    const dkey = `deposits:${pool.pool}`;
    const drec = (await d.store.get(dkey)) ?? {};
    if (drec.retryAt && now() < drec.retryAt) return;
    let left = p.depositActionsPerTick;

    // 1. Delivered withdrawals: their outputs become known coins.
    for (const id of await d.chain.unregistered(pool.pool)) {
      if (left <= 0) return;
      const sig = await d.chain.registerCoin(pool.pool, id);
      left--;
      log(
        `${name}: withdrawal ${id}'s Bitcoin output is a known coin (${sig})`,
      );
    }

    // 2. Deposits with an owner: credited.
    const coins = await d.chain.coins(pool.pool);
    for (const c of coins) {
      if (!c.deposit || c.credited || !c.owner) continue;
      if (left <= 0) return;
      const sig = await d.chain.creditDeposit(pool.pool, c);
      left--;
      log(
        `${name}: deposit ${c.txid}:${c.vout} credited: ${c.runes} units to ${c.owner} (${sig})`,
      );
    }

    // 3. Known coins moved on Bitcoin: proven (round robin, a few a tick).
    const free = coins.filter((c) => !c.deposit);
    if (!free.length) return;
    const start = (cursors.get(pool.pool) ?? 0) % free.length;
    const n = Math.min(free.length, p.coinChecksPerTick);
    cursors.set(pool.pool, start + n);
    const done = new Set<string>();
    const id = { block: pool.runeBlock, tx: BigInt(pool.runeTx) };
    for (let k = 0; k < n && left > 0; k++) {
      const c = free[(start + k) % free.length];
      const s = await d.bitcoin.spender(c.txid, c.vout);
      if (!s || s.height === null || done.has(s.txid)) continue;
      done.add(s.txid);
      if (tip - s.height + 1 < minConf) continue;
      const tkey = `tx:${pool.pool}:${s.txid}`;
      if ((await d.store.get(tkey))?.stuck) continue;
      const stuck = async (why: string) => {
        await d.store.put(tkey, { stuck: true, lastError: why });
        log(`${name}: ${s.txid} cannot be proven: ${why}`);
      };
      if (await d.chain.proven(pool.pool, s.txid)) {
        await stuck(
          `proven before without ${c.txid}:${c.vout} (its Runes stay unknown)`,
        );
        continue;
      }
      const proof = await d.bitcoin.prove(s.txid);
      if (!proof) continue;
      const tx = txBasics(proof.rawTx);
      if (tx.inputs.some((i) => i.txid === v.coinTxid && i.vout === v.coinVout))
        continue; // a vault spend: prove_vault_spend's
      const ins = free.filter((f) =>
        tx.inputs.some((i) => i.txid === f.txid && i.vout === f.vout),
      );
      // The program takes every input (known or not), at most this many.
      if (tx.inputs.length > p.maxCoinInputs) {
        await stuck(
          `${tx.inputs.length} inputs (max ${p.maxCoinInputs} in a proof)`,
        );
        continue;
      }
      const units = ins.reduce((a, f) => a + f.runes, 0n);
      const alloc = allocateRune(
        tx.outputs,
        decipherRunestone(tx.outputs),
        id,
        units,
      );
      const outs = alloc.flatMap((u, i) => (u > 0n ? [i] : []));
      if (outs.length > p.maxCoinOutputs) {
        await stuck(
          `${outs.length} outputs with Runes (max ${p.maxCoinOutputs})`,
        );
        continue;
      }
      const sig = await d.chain.proveCoinSpend(
        pool.pool,
        proof,
        tx.inputs,
        outs,
      );
      left--;
      const burned = units - alloc.reduce((a, u) => a + u, 0n);
      log(
        `${name}: Runes moved on Bitcoin ${s.txid}: ${units} units from ${ins.length} known coin(s) -> output(s) ${outs.join(', ') || 'none'}${burned > 0n ? `, ${burned} burned` : ''} (${sig})`,
      );
    }
  }

  async function tick() {
    let tip: number;
    try {
      tip = await syncHeaders();
    } catch (e) {
      log(`headers: ${msg(e)}`);
      tip = await d.chain.relayTip();
    }
    const minConf = await d.chain.minConfirmations();
    for (const pool of await d.chain.pools()) {
      if ((await d.store.get(`pool:${pool.pool}`))?.ours === true)
        try {
          await deposits(pool, tip, minConf);
        } catch (e) {
          const dkey = `deposits:${pool.pool}`;
          const code = msg(e);
          await d.store.put(dkey, {
            retryAt: now() + p.retrySeconds,
            lastError: code,
          });
          log(
            `${short(pool.pool)}: deposits: ${code} (retry in ${p.retrySeconds / 60} min)`,
          );
        }
      try {
        await step(pool, tip, minConf);
      } catch (e) {
        const key = `pool:${pool.pool}`;
        const rec = (await d.store.get(key)) ?? {};
        const code = msg(e);
        // The canister refuses vaults that are not its key: never ask again.
        if (/NOT_THIS_CANISTERS_VAULT/.test(code)) rec.ours = false;
        rec.retryAt = now() + p.retrySeconds;
        rec.lastError = code;
        await d.store.put(key, rec);
        log(
          `${short(pool.pool)}: ${code} (retry in ${p.retrySeconds / 60} min)`,
        );
      }
    }
  }

  return { tick, syncHeaders };
}
export type PoolRelayer = ReturnType<typeof createPoolRelayer>;

/** A store in memory (tests). */
export function memoryPoolRelayerStore(): PoolRelayerStore & {
  dump(): Record<string, RelayerRecord>;
} {
  const m = new Map<string, RelayerRecord>();
  return {
    async get(k) {
      const r = m.get(k);
      return r ? { ...r } : null;
    },
    async put(k, r) {
      m.set(k, { ...r });
    },
    dump: () => Object.fromEntries(m),
  };
}
