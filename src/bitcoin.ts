import { concat, fromHex, hex } from './borsh.ts';
import type {
  PoolRelayerBitcoin,
  RelayerNamedProof,
  RelayerProof,
} from './keeper.ts';
import { runeCommitment } from './runestone.ts';

/**
 * Bitcoin for the keeper, from any Esplora server (mempool.space, your own
 * node's electrs): headers, transactions and their Merkle proofs (checked
 * against the block's Merkle root before use), and named Runes' proofs.
 * WebCrypto only: runs in Node 20+, Bun, Deno and browsers.
 */
export const MEMPOOL_API = 'https://mempool.space/api';

export async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest(
      'SHA-256',
      Uint8Array.from(b) as Uint8Array<ArrayBuffer>,
    ),
  );
}
export const sha256d = async (b: Uint8Array) => sha256(await sha256(b));
const reversed = (b: Uint8Array) => Uint8Array.from(b).reverse();
/** Display order (as explorers show it) <-> internal byte order. */
export const internalTxid = (displayHex: string) =>
  reversed(fromHex(displayHex.trim()));
export const displayTxid = (internal: Uint8Array) => hex(reversed(internal));
const eqBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};

/** A transaction read from `at`: where it ends, inputs, witness stacks. */
function readTx(b: Uint8Array, start: number) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = start + 4;
  const segwit = b[at] === 0 && b[at + 1] === 1;
  if (segwit) at += 2;
  const varint = () => {
    const f = b[at++];
    if (f < 0xfd) return f;
    if (f === 0xfd) {
      const x = v.getUint16(at, true);
      at += 2;
      return x;
    }
    if (f === 0xfe) {
      const x = v.getUint32(at, true);
      at += 4;
      return x;
    }
    const x = Number(v.getBigUint64(at, true));
    at += 8;
    return x;
  };
  const inputs: { txid: string; vout: number }[] = [];
  const nin = varint();
  for (let i = 0; i < nin; i++) {
    inputs.push({
      txid: displayTxid(b.subarray(at, at + 32)),
      vout: v.getUint32(at + 32, true),
    });
    at += 36;
    const script = varint();
    at += script + 4;
  }
  const outsStart = at;
  const nout = varint();
  for (let i = 0; i < nout; i++) {
    at += 8;
    const script = varint();
    at += script;
  }
  const outsEnd = at;
  const witnesses: Uint8Array[][] = inputs.map(() => []);
  if (segwit)
    for (const w of witnesses) {
      const n = varint();
      for (let k = 0; k < n; k++) {
        const len = varint();
        w.push(b.subarray(at, at + len));
        at += len;
      }
    }
  at += 4;
  if (at > b.length) throw new Error('truncated transaction');
  return { end: at, segwit, inputs, witnesses, outsStart, outsEnd };
}

/** A transaction without its witness (what the txid commits to). */
export function stripWitness(raw: Uint8Array): Uint8Array {
  const t = readTx(raw, 0);
  if (!t.segwit) return raw;
  // version | inputs .. outputs (from after the marker) | lock time
  return concat(
    raw.subarray(0, 4),
    raw.subarray(6, t.outsEnd),
    raw.subarray(t.end - 4, t.end),
  );
}
/** Inputs and witness stacks of a full transaction. */
export const txWitnesses = (raw: Uint8Array) => readTx(raw, 0);

/** Every transaction of a raw block (with witnesses), in order. */
export function blockTxs(block: Uint8Array): Uint8Array[] {
  const v = new DataView(block.buffer, block.byteOffset, block.byteLength);
  let at = 80;
  const f = block[at++];
  let n = f;
  if (f === 0xfd) {
    n = v.getUint16(at, true);
    at += 2;
  } else if (f === 0xfe) {
    n = v.getUint32(at, true);
    at += 4;
  } else if (f === 0xff) throw new Error('block too big');
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const t = readTx(block, at);
    out.push(block.subarray(at, t.end));
    at = t.end;
  }
  if (at !== block.length) throw new Error('block has trailing bytes');
  return out;
}

/** The Merkle branch of leaf `index` (internal byte order hashes). */
export async function merkleBranch(
  leaves: Uint8Array[],
  index: number,
): Promise<Uint8Array[]> {
  const branch: Uint8Array[] = [];
  let level = leaves;
  let i = index;
  while (level.length > 1) {
    branch.push(
      i % 2 === 1
        ? level[i - 1]
        : i + 1 < level.length
          ? level[i + 1]
          : level[i],
    );
    const next: Uint8Array[] = [];
    for (let k = 0; k < level.length; k += 2)
      next.push(await sha256d(concat(level[k], level[k + 1] ?? level[k])));
    level = next;
    i = Math.floor(i / 2);
  }
  return branch;
}
async function rootOf(leaf: Uint8Array, index: number, branch: Uint8Array[]) {
  let h = leaf;
  let i = index;
  for (const s of branch) {
    h = await sha256d(i % 2 === 1 ? concat(s, h) : concat(h, s));
    i = Math.floor(i / 2);
  }
  return h;
}

/**
 * btc-light `tx_shaped`: the 64 bytes `l || r` read as a transaction (one
 * input, one output, 4 bytes of scripts). A Merkle level shaped like that
 * could be a real 64-byte transaction posing as an inner node, so the
 * program wants the block's depth (its coinbase's branch) for such a proof.
 */
export function txShaped(l: Uint8Array, r: Uint8Array): boolean {
  const at = (i: number) => (i < 32 ? l[i] : r[i - 32]);
  if (at(4) !== 1) return false;
  const s = at(41);
  return s <= 4 && at(46 + s) === 1 && at(55 + s) === 4 - s;
}
/** Whether a level of this branch is {@link txShaped} (btc-light `root_and_shape`). */
export async function branchShaped(
  leaf: Uint8Array,
  index: number,
  branch: Uint8Array[],
): Promise<boolean> {
  let h = leaf;
  let i = index;
  let shaped = false;
  for (const s of branch) {
    const [l, r] = i % 2 === 1 ? [s, h] : [h, s];
    shaped ||= txShaped(l, r);
    h = await sha256d(concat(l, r));
    i = Math.floor(i / 2);
  }
  return shaped;
}

/** The script of a Taproot script-path spend (null: key path / not Taproot). */
export function tapscriptOf(stack: Uint8Array[]): Uint8Array | null {
  let s = stack;
  if (s.length >= 2 && s[s.length - 1][0] === 0x50) s = s.slice(0, -1); // annex
  return s.length >= 2 ? s[s.length - 2] : null;
}
const indexOf = (hay: Uint8Array, needle: Uint8Array) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++)
      if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
};

/**
 * An Esplora server as the keeper's Bitcoin: every proof is checked
 * against the block's Merkle root, every header against its hash and its
 * parent, before it is used.
 */
export function esplora(
  base = MEMPOOL_API,
  f: typeof fetch = fetch,
): PoolRelayerBitcoin & {
  get(path: string, text?: boolean): Promise<unknown>;
} {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function get(path: string, text = false): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const r = await f(`${base}${path}`, {
        signal: AbortSignal.timeout(30_000),
      }).catch(() => null);
      if (r?.ok) return text ? r.text() : r.json();
      if (r && r.status === 404) return null;
      if (attempt >= 3)
        throw new Error(
          `esplora ${path.split('?')[0]}: ${r?.status ?? 'no answer'}`,
        );
      await sleep(2_000 * (attempt + 1));
    }
  }
  async function raw(path: string): Promise<Uint8Array> {
    const r = await f(`${base}${path}`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`esplora ${path}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  const hashAt = async (h: number) => {
    const v = (await get(`/block-height/${h}`, true)) as string | null;
    if (!v || !/^[0-9a-f]{64}$/.test(v.trim()))
      throw new Error(`no block at ${h}`);
    return v.trim();
  };

  async function prove(txid: string): Promise<RelayerProof | null> {
    const st = (await get(`/tx/${txid}/status`)) as {
      confirmed: boolean;
      block_height?: number;
      block_hash?: string;
    } | null;
    if (!st?.confirmed || !st.block_hash || st.block_height === undefined)
      return null;
    const full = fromHex(
      ((await get(`/tx/${txid}/hex`, true)) as string).trim(),
    );
    const rawTx = stripWitness(full);
    const id = await sha256d(rawTx);
    if (!eqBytes(id, internalTxid(txid))) throw new Error('txid mismatch');
    const ids = ((await get(`/block/${st.block_hash}/txids`)) as string[]).map(
      internalTxid,
    );
    const block = (await get(`/block/${st.block_hash}`)) as {
      merkle_root: string;
    };
    const index = ids.findIndex((x) => eqBytes(x, id));
    if (index < 0) throw new Error('not in its block');
    const branch = await merkleBranch(ids, index);
    if (
      !eqBytes(await rootOf(id, index, branch), internalTxid(block.merkle_root))
    )
      throw new Error('branch does not reach the Merkle root');
    const proof: RelayerProof = {
      txid: id,
      height: st.block_height,
      rawTx,
      index,
      branch,
    };
    // About once in 2^26 a real branch looks like a forged one: the program
    // then wants the block's depth (its coinbase and the coinbase's branch).
    if (await branchShaped(id, index, branch)) {
      const cb = stripWitness(
        fromHex(
          (
            (await get(`/tx/${displayTxid(ids[0])}/hex`, true)) as string
          ).trim(),
        ),
      );
      if (!eqBytes(await sha256d(cb), ids[0]))
        throw new Error('coinbase txid mismatch');
      proof.coinbase = { rawTx: cb, branch: await merkleBranch(ids, 0) };
    }
    return proof;
  }

  return {
    get,
    tip: async () => Number(await get('/blocks/tip/height', true)),
    async headers(from: number, to: number) {
      const out: Uint8Array[] = [];
      for (let h = from; h <= to; h++) {
        const hash = await hashAt(h);
        const hdr = fromHex(
          ((await get(`/block/${hash}/header`, true)) as string).trim(),
        );
        if (hdr.length !== 80 || displayTxid(await sha256d(hdr)) !== hash)
          throw new Error(`header ${h}: hash mismatch`);
        if (
          out.length &&
          !eqBytes(hdr.subarray(4, 36), await sha256d(out[out.length - 1]))
        )
          throw new Error(`headers do not link at ${h}`);
        out.push(hdr);
        await sleep(150);
      }
      return out;
    },
    async txidAt(height: number, index: number) {
      const t = (
        (await get(
          `/block/${await hashAt(height)}/txid/${index}`,
          true,
        )) as string
      ).trim();
      if (!/^[0-9a-f]{64}$/.test(t))
        throw new Error(`no tx ${height}:${index}`);
      return t;
    },
    async spender(txid: string, vout: number) {
      const s = (await get(`/tx/${txid}/outspend/${vout}`)) as {
        spent: boolean;
        txid?: string;
        status?: { confirmed: boolean; block_height?: number };
      } | null;
      if (!s?.spent || !s.txid) return null;
      return {
        txid: s.txid,
        height: s.status?.confirmed ? (s.status.block_height ?? null) : null,
      };
    },
    prove,
    async feeRate() {
      const r = (await get('/v1/fees/recommended')) as {
        halfHourFee?: number;
      } | null;
      return r?.halfHourFee ?? 2;
    },
    /**
     * `activate_named`'s proof of a confirmed named etching: the etching
     * (with witness) and its txid and wtxid branches, the coinbase (with
     * witness) and its branch, the commit transaction (the input whose
     * tapscript pushes the name's commitment) and its branch.
     */
    async namedProof(
      etchTxid: string,
      rune: bigint,
    ): Promise<RelayerNamedProof | null> {
      const st = (await get(`/tx/${etchTxid}/status`)) as {
        confirmed: boolean;
        block_hash?: string;
      } | null;
      if (!st?.confirmed || !st.block_hash) return null;
      const etch = fromHex(
        ((await get(`/tx/${etchTxid}/hex`, true)) as string).trim(),
      );
      const block = await raw(`/block/${st.block_hash}/raw`);
      if (displayTxid(await sha256d(block.subarray(0, 80))) !== st.block_hash)
        throw new Error('block hash mismatch');
      const txs = blockTxs(block);
      const txids: Uint8Array[] = [];
      const wtxids: Uint8Array[] = [];
      for (const t of txs) {
        txids.push(await sha256d(stripWitness(t)));
        wtxids.push(await sha256d(t));
      }
      wtxids[0] = new Uint8Array(32);
      const index = txids.findIndex((x) => eqBytes(x, internalTxid(etchTxid)));
      if (index < 0 || !eqBytes(txs[index], etch))
        throw new Error('etching not in its block');
      const commitment = runeCommitment(rune);
      const push = concat(Uint8Array.from([commitment.length]), commitment);
      const { inputs, witnesses } = txWitnesses(etch);
      for (let i = 0; i < inputs.length; i++) {
        const script = tapscriptOf(witnesses[i]);
        if (!script || indexOf(script, push) < 0) continue;
        const c = await prove(inputs[i].txid);
        if (!c) continue;
        const bytes = (b: Uint8Array) => concat(u32(b.length), b);
        const branch = (bs: Uint8Array[]) =>
          concat(Uint8Array.from([bs.length]), ...bs);
        return {
          payload: concat(
            bytes(etch),
            branch(await merkleBranch(txids, index)),
            branch(await merkleBranch(wtxids, index)),
            bytes(txs[0]),
            branch(await merkleBranch(txids, 0)),
            bytes(c.rawTx),
            branch(c.branch),
          ),
          commitHeight: c.height,
          commitIndex: c.index,
        };
      }
      return null;
    },
  };
}
