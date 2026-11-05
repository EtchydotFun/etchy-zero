import * as btc from '@scure/btc-signer';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from './bitcoin.ts';
import type { PoolRelayerPictures } from './keeper.ts';

/**
 * Ordinal Runes: a Zero Rune whose logo (the Rune's parent inscription,
 * `<etch txid>i0`) has a collection of pictures that become child
 * inscriptions one at a time, when a holder mints them.
 *
 *   launch   the etching inscribes the logo (output 0, to the collection's
 *            ord address: the vault canister's `launch_ord_address`) and
 *            the collection's fingerprint (Merkle root of the pictures);
 *            the files live elsewhere (Arweave)
 *   open     `ord_take_out` burns one unit of Runes per picture; a Bitcoin
 *            block mined after it draws free pictures (`ord_draw`)
 *   batch    the vault's batch burns them (edict to its OP_RETURN) and pays
 *            one commit per picture: P2TR(unspendable key, ONE leaf
 *            `<ord key> OP_CHECKSIG <envelope: picture, parent = the logo,
 *            pointer>`)
 *   reveal   in0 the logo (key path of the ord key), then the commits
 *            (script path); out0 the logo back, outJ picture J (546 sats,
 *            by its pointer) to its holder
 *
 * The canister builds and signs both (vault-core `ordinals.rs`, byte for
 * byte these functions). The spikes here proved them against ord 0.29.1.
 */
export const ORDINAL_POSTAGE = 546n;
export const LEAF_VERSION = 0xc0;
const OP_0 = 0x00;
const OP_IF = 0x63;
const OP_ENDIF = 0x68;
const OP_CHECKSIG = 0xac;
const MAX_PUSH = 520;
/** ord envelope tags. */
export const ORD_TAG = Object.freeze({
  contentType: 1,
  pointer: 2,
  parent: 3,
  metadata: 5,
});
const TX_OPTS = { allowUnknownOutputs: true, allowUnknownInputs: true };

const fromHex = (h: string) =>
  Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const concat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of p) out.set(x, (o += x.length) - x.length);
  return out;
};
/** rust-bitcoin push_slice (minimal push opcode for the length). */
function push(data: Uint8Array): number[] {
  const n = data.length;
  if (n > MAX_PUSH) throw new Error('push too large');
  if (n <= 75) return [n, ...data];
  if (n <= 0xff) return [0x4c, n, ...data];
  return [0x4d, n & 0xff, n >> 8, ...data];
}
const compactSize = (n: number) =>
  n < 0xfd ? Uint8Array.of(n) : Uint8Array.of(0xfd, n & 0xff, n >> 8);
/** Little-endian, trailing zero bytes dropped (ord's integer field encoding). */
function leTrimmed(n: bigint): Uint8Array {
  const out: number[] = [];
  for (let v = n; v > 0n; v >>= 8n) out.push(Number(v & 0xffn));
  return Uint8Array.from(out);
}
/** ord `InscriptionId::value()`: txid bytes (internal order) + index (trimmed LE). */
export function inscriptionIdValue(id: {
  txid: string;
  index: number;
}): Uint8Array {
  return concat(fromHex(id.txid).reverse(), leTrimmed(BigInt(id.index)));
}
export interface ChildInscription {
  contentType: string;
  content: Uint8Array;
  parent: { txid: string; index: number };
  /** Sat offset in the reveal's outputs: output J starts at J x 546. */
  pointer: bigint;
}
/** OP_FALSE OP_IF "ord" 01 <type> 02 <pointer> 03 <parent> 00 <body> OP_ENDIF. */
export function childEnvelope(c: ChildInscription): Uint8Array {
  if (!c.content.length) throw new Error('empty picture');
  const out: number[] = [OP_0, OP_IF, ...push(new TextEncoder().encode('ord'))];
  out.push(
    ...push(Uint8Array.of(ORD_TAG.contentType)),
    ...push(new TextEncoder().encode(c.contentType)),
  );
  out.push(
    ...push(Uint8Array.of(ORD_TAG.pointer)),
    ...push(leTrimmed(c.pointer)),
  );
  out.push(
    ...push(Uint8Array.of(ORD_TAG.parent)),
    ...push(inscriptionIdValue(c.parent)),
  );
  out.push(OP_0);
  for (let i = 0; i < c.content.length; i += MAX_PUSH)
    out.push(...push(c.content.subarray(i, i + MAX_PUSH)));
  out.push(OP_ENDIF);
  return Uint8Array.from(out);
}
/** `<32-byte launch key> OP_CHECKSIG <envelope>` (ord's batch layout). */
export function childLeaf(
  launchKey: Uint8Array,
  c: ChildInscription,
): Uint8Array {
  if (launchKey.length !== 32) throw new Error('x-only key');
  return Uint8Array.from([32, ...launchKey, OP_CHECKSIG, ...childEnvelope(c)]);
}
/** The picture's commit: unspendable internal key, this ONE leaf. */
export function childCommit(leaf: Uint8Array, network = btc.NETWORK) {
  return btc.p2tr(
    btc.TAPROOT_UNSPENDABLE_KEY,
    { script: leaf, leafVersion: LEAF_VERSION },
    network,
    true,
  );
}
export const tapLeafHash = (leaf: Uint8Array) =>
  schnorr.utils.taggedHash(
    'TapLeaf',
    Uint8Array.of(LEAF_VERSION),
    compactSize(leaf.length),
    leaf,
  );

const N = secp256k1.CURVE.n;
const G = secp256k1.ProjectivePoint.BASE;
const mod = (a: bigint) => ((a % N) + N) % N;
const big = (b: Uint8Array) => BigInt(`0x${toHex(b) || '0'}`);
const be32 = (n: bigint) => fromHex(n.toString(16).padStart(64, '0'));
/** Q = P + t*G with P = lift_x(internal), t = TapTweak(internal || leaf hash): the output key. */
export function commitOutputKey(
  leafHash: Uint8Array,
  internal = btc.TAPROOT_UNSPENDABLE_KEY,
) {
  const P = schnorr.utils.lift_x(big(internal));
  const t = big(schnorr.utils.taggedHash('TapTweak', internal, leafHash));
  const Q = P.add(G.multiply(t)).toAffine();
  return { x: be32(Q.x), odd: (Q.y & 1n) === 1n };
}
/**
 * The same output key the way the Solana program gets it: ONE
 * secp256k1_recover. ECDSA recovery gives r^-1 (s*R - z*G); with R = P
 * (r = P.x, recovery id = P.y's parity), s = r and z = -t*r it is P + t*G.
 * Returns what the program passes to the syscall, and the key it gets back.
 */
export function tweakByRecover(
  leafHash: Uint8Array,
  internal = btc.TAPROOT_UNSPENDABLE_KEY,
) {
  const P = schnorr.utils.lift_x(big(internal)).toAffine(); // even y (BIP340)
  const r = P.x;
  if (r >= N) throw new Error('internal key x >= n');
  const t = big(schnorr.utils.taggedHash('TapTweak', internal, leafHash));
  const z = mod(-t * r);
  // High s is fine for recovery; the program may also use n - s with the other parity.
  const sig = new secp256k1.Signature(r, r).addRecoveryBit(Number(P.y & 1n));
  const Q = sig.recoverPublicKey(be32(z)).toAffine();
  return {
    hash: be32(z),
    recoveryId: Number(P.y & 1n),
    signature: concat(be32(r), be32(r)),
    x: be32(Q.x),
    odd: (Q.y & 1n) === 1n,
  };
}

// ---------------------------------------------------------------- transactions
const p2trKey = (xonly: Uint8Array, network = btc.NETWORK) =>
  btc.p2tr(xonly, undefined, network);
export interface Coin {
  txid: string;
  vout: number;
  sats: bigint;
}
/** Script-path witness bytes: [64-byte sig, leaf, 33-byte control block]. */
const childWitnessBytes = (leaf: Uint8Array) =>
  1 + 65 + compactSize(leaf.length).length + leaf.length + 34;
/** Key-path witness bytes: [64-byte sig]. */
const KEY_WITNESS = 1 + 65;

function revealTx(
  parent: Coin,
  parentTo: Uint8Array,
  children: (Coin & { leaf: Uint8Array })[],
  childTo: Uint8Array,
  launchKey: Uint8Array,
  network = btc.NETWORK,
) {
  const tx = new btc.Transaction({ version: 2, ...TX_OPTS });
  tx.addInput({
    txid: parent.txid,
    index: parent.vout,
    witnessUtxo: {
      script: p2trKey(launchKey, network).script,
      amount: parent.sats,
    },
    tapInternalKey: launchKey,
  });
  for (const c of children) {
    const commit = childCommit(c.leaf, network);
    tx.addInput({
      txid: c.txid,
      index: c.vout,
      witnessUtxo: { script: commit.script, amount: c.sats },
      tapLeafScript: commit.tapLeafScript,
    });
  }
  tx.addOutput({ script: parentTo, amount: ORDINAL_POSTAGE });
  for (let j = 0; j < children.length; j++)
    tx.addOutput({ script: childTo, amount: ORDINAL_POSTAGE });
  return tx;
}
/** The reveal's exact vsize (signature sizes are fixed): known before anything is funded. */
export function revealVsize(
  leaves: Uint8Array[],
  parentTo: Uint8Array,
  childTo: Uint8Array,
  launchKey: Uint8Array,
) {
  const dummy = '00'.repeat(32);
  const tx = revealTx(
    { txid: dummy, vout: 0, sats: ORDINAL_POSTAGE },
    parentTo,
    leaves.map((leaf, i) => ({
      txid: dummy,
      vout: i,
      sats: ORDINAL_POSTAGE,
      leaf,
    })),
    childTo,
    launchKey,
  );
  const witness =
    KEY_WITNESS + leaves.reduce((s, l) => s + childWitnessBytes(l), 0);
  return Math.ceil((tx.unsignedTx.length * 4 + 2 + witness) / 4);
}
/** What each picture's commit holds: 546 + its share of the reveal fee (the first takes the rest). */
export function childAmounts(count: number, revealFeeSats: bigint): bigint[] {
  const share = revealFeeSats / BigInt(count);
  return Array.from(
    { length: count },
    (_, i) =>
      ORDINAL_POSTAGE +
      share +
      (i === 0 ? revealFeeSats - share * BigInt(count) : 0n),
  );
}
/** The funding: the launch key's coin -> one commit per picture (exact amounts, the rest is the fee). */
export function buildFunding(
  from: Coin,
  launchSecret: Uint8Array,
  commits: { script: Uint8Array; sats: bigint }[],
  network = btc.NETWORK,
) {
  const key = schnorr.getPublicKey(launchSecret);
  const tx = new btc.Transaction({ version: 2, ...TX_OPTS });
  tx.addInput({
    txid: from.txid,
    index: from.vout,
    witnessUtxo: { script: p2trKey(key, network).script, amount: from.sats },
    tapInternalKey: key,
  });
  for (const c of commits) tx.addOutput({ script: c.script, amount: c.sats });
  const out = commits.reduce((s, c) => s + c.sats, 0n);
  if (out > from.sats) throw new Error('funding: not enough');
  tx.signIdx(launchSecret, 0);
  tx.finalize();
  return {
    tx,
    txid: tx.id,
    rawHex: toHex(tx.extract()),
    feeSats: from.sats - out,
  };
}
/** One reveal: the logo (key path) and the pictures (script path) in; the logo and the pictures out. */
export function buildReveal(p: {
  parent: Coin;
  parentTo: Uint8Array;
  children: (Coin & { leaf: Uint8Array })[];
  childTo: Uint8Array;
  launchSecret: Uint8Array;
  network?: typeof btc.NETWORK;
}) {
  const key = schnorr.getPublicKey(p.launchSecret);
  const tx = revealTx(
    p.parent,
    p.parentTo,
    p.children,
    p.childTo,
    key,
    p.network,
  );
  const prevScripts = [
    p2trKey(key, p.network).script,
    ...p.children.map((c) => childCommit(c.leaf, p.network).script),
  ];
  const amounts = [p.parent.sats, ...p.children.map((c) => c.sats)];
  p.children.forEach((c, i) => {
    const idx = i + 1;
    const msg = tx.preimageWitnessV1(
      idx,
      prevScripts,
      btc.SigHash.DEFAULT,
      amounts,
      -1,
      c.leaf,
      LEAF_VERSION,
    );
    const sig = schnorr.sign(msg, p.launchSecret);
    const [cb] = tx.getInput(idx).tapLeafScript![0];
    tx.updateInput(
      idx,
      { finalScriptWitness: [sig, c.leaf, btc.TaprootControlBlock.encode(cb)] },
      true,
    );
  });
  tx.signIdx(p.launchSecret, 0);
  tx.finalizeIdx(0);
  const inSats = amounts.reduce((s, a) => s + a, 0n);
  const outSats = ORDINAL_POSTAGE * BigInt(p.children.length + 1);
  return {
    tx,
    txid: tx.id,
    rawHex: toHex(tx.extract()),
    feeSats: inSats - outSats,
    vsize: tx.vsize,
  };
}

/**
 * What the program will check, from the two transactions' bytes alone (no
 * witness needed: their txids are what the light client proves):
 *  - funding output `fundingVout` is P2TR whose key is tweak(unspendable,
 *    leafHash) (one recover), so it can only reveal that picture;
 *  - the reveal spends that output, spends the logo's outpoint (the parent
 *    is honoured), and its output `j` (the pointer's) pays the vault 546.
 */
export function checkPlacement(p: {
  fundingRawHex: string;
  revealRawHex: string;
  logo: { txid: string; vout: number };
  items: { leafHash: Uint8Array; fundingVout: number; revealOutput: number }[];
  vaultScript: Uint8Array;
}): string[] {
  const problems: string[] = [];
  const funding = btc.Transaction.fromRaw(fromHex(p.fundingRawHex), TX_OPTS);
  const reveal = btc.Transaction.fromRaw(fromHex(p.revealRawHex), TX_OPTS);
  const ins = Array.from({ length: reveal.inputsLength }, (_, i) =>
    reveal.getInput(i),
  );
  const spends = (txid: string, vout: number) =>
    ins.some((x) => toHex(x.txid!) === txid && x.index === vout);
  if (!spends(p.logo.txid, p.logo.vout))
    problems.push('reveal does not spend the logo');
  for (const it of p.items) {
    const out = funding.getOutput(it.fundingVout);
    const s = out.script!;
    const k = tweakByRecover(it.leafHash);
    if (!(
      s.length === 34 &&
      s[0] === 0x51 &&
      s[1] === 32 &&
      toHex(s.subarray(2)) === toHex(k.x)
    ))
      problems.push(
        `funding output ${it.fundingVout} is not this picture's commit`,
      );
    if (!spends(funding.id, it.fundingVout))
      problems.push(`reveal does not spend funding:${it.fundingVout}`);
    const o = reveal.getOutput(it.revealOutput);
    if (
      !o.script ||
      toHex(o.script) !== toHex(p.vaultScript) ||
      o.amount !== ORDINAL_POSTAGE
    )
      problems.push(`reveal output ${it.revealOutput} is not 546 to the vault`);
  }
  return problems;
}
export { toHex as ordinalsHex, fromHex as ordinalsUnhex };

// ---------------------------------------------------------------- the collection's fingerprint
// Byte for byte the program's (ordinals.rs picture_hash / picture_leaf / merkle_root / verify_picture):
// fixed at launch (in the logo's inscription and the program), so no picture can ever be swapped.
const le32 = (n: number) =>
  Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
/** sha256(content type || 0x00 || content). */
export const pictureHash = async (contentType: string, content: Uint8Array) =>
  sha256(
    concat(new TextEncoder().encode(contentType), Uint8Array.of(0), content),
  );
/** Leaf `index`: sha256(0x00 || le32(index) || picture hash). */
export const pictureLeaf = (index: number, picture: Uint8Array) =>
  sha256(concat(Uint8Array.of(0), le32(index), picture));
const node = (l: Uint8Array, r: Uint8Array) =>
  sha256(concat(Uint8Array.of(1), l, r));
async function up(level: Uint8Array[]) {
  const next: Uint8Array[] = [];
  for (let i = 0; i < level.length; i += 2)
    next.push(
      i + 1 < level.length ? await node(level[i], level[i + 1]) : level[i],
    );
  return next;
}
/** The root over the leaves (a node without a sibling goes up unchanged). */
export async function collectionRoot(
  leaves: Uint8Array[],
): Promise<Uint8Array> {
  if (!leaves.length) return new Uint8Array(32);
  let level = leaves;
  while (level.length > 1) level = await up(level);
  return level[0];
}
/** Picture `index`'s proof (its siblings, bottom up). */
export async function collectionProof(
  leaves: Uint8Array[],
  index: number,
): Promise<Uint8Array[]> {
  const proof: Uint8Array[] = [];
  let [i, level] = [index, leaves];
  while (level.length > 1) {
    if ((i ^ 1) < level.length) proof.push(level[i ^ 1]);
    level = await up(level);
    i >>= 1;
  }
  return proof;
}
export async function verifyPicture(
  root: Uint8Array,
  size: number,
  index: number,
  picture: Uint8Array,
  proof: Uint8Array[],
) {
  if (index >= size) return false;
  let h = await pictureLeaf(index, picture);
  let [i, n, used] = [index, size, 0];
  while (n > 1) {
    if ((i ^ 1) < n) {
      const s = proof[used++];
      if (!s) return false;
      h = i % 2 === 0 ? await node(h, s) : await node(s, h);
    }
    i >>= 1;
    n = Math.ceil(n / 2);
  }
  return used === proof.length && toHex(h) === toHex(root);
}
/** A whole collection's fingerprint (what the launch inscribes and `create_collection` stores). */
export async function collectionFingerprint(
  pictures: { contentType: string; content: Uint8Array }[],
) {
  const hashes = await Promise.all(
    pictures.map((p) => pictureHash(p.contentType, p.content)),
  );
  const leaves = await Promise.all(hashes.map((h, i) => pictureLeaf(i, h)));
  return { root: await collectionRoot(leaves), hashes, leaves };
}
/**
 * A keeper's pictures (keeper.ts `PoolRelayerPictures`) from collections'
 * files: pool -> its pictures in collection order. Each comes with its proof
 * against the root; the vault canister checks it.
 */
export function collectionPictures(
  collections: Record<string, { contentType: string; content: Uint8Array }[]>,
): PoolRelayerPictures {
  const leaves = new Map<string, Promise<Uint8Array[]>>();
  return {
    async pictures(pool, items) {
      const list = collections[pool];
      if (!list) return null;
      if (!leaves.has(pool))
        leaves.set(
          pool,
          collectionFingerprint(list).then((f) => f.leaves),
        );
      const all = await leaves.get(pool)!;
      return Promise.all(
        items.map(async (index) => {
          const p = list[index];
          if (!p) throw new Error(`picture ${index} is not in the files`);
          return {
            index,
            contentType: p.contentType,
            content: p.content,
            proof: await collectionProof(all, index),
          };
        }),
      );
    },
  };
}

/**
 * A keeper's pictures from a pool API that keeps collections (Etchy Zero's:
 * `GET /v1/pools/:pool/collection`, `GET /v1/collections/:id/pictures/:i`).
 * Every picture is checked against the list's hashes and the list against
 * its root (the vault canister checks the root is the program's).
 */
export function httpCollectionPictures(
  base: string,
  get: typeof fetch = fetch,
): PoolRelayerPictures {
  const lists = new Map<
    string,
    Promise<{
      id: string;
      root: string;
      pictures: { contentType: string; hash: string }[];
    } | null>
  >();
  const list = (pool: string) => {
    if (!lists.has(pool))
      lists.set(
        pool,
        (async () => {
          const r = await get(`${base}/v1/pools/${pool}/collection`, {
            signal: AbortSignal.timeout(20_000),
          });
          if (r.status === 404) return null;
          if (!r.ok) throw new Error(`collection of ${pool}: HTTP ${r.status}`);
          const v = (await r.json()) as {
            id: string;
            root: string | null;
            pictures: { index: number; contentType: string; hash: string }[];
          };
          if (!v.root || v.pictures.some((p, i) => p.index !== i))
            throw new Error(`collection of ${pool}: not sealed`);
          const leaves = await Promise.all(
            v.pictures.map((p, i) => pictureLeaf(i, fromHex(p.hash))),
          );
          if (toHex(await collectionRoot(leaves)) !== v.root)
            throw new Error(`collection of ${pool}: its list is not its root`);
          return { id: v.id, root: v.root, pictures: v.pictures };
        })().catch((e: unknown) => {
          lists.delete(pool);
          throw e;
        }),
      );
    return lists.get(pool)!;
  };
  return {
    async pictures(pool, items) {
      const v = await list(pool);
      if (!v) return null;
      const leaves = await Promise.all(
        v.pictures.map((p, i) => pictureLeaf(i, fromHex(p.hash))),
      );
      return Promise.all(
        items.map(async (index) => {
          const p = v.pictures[index];
          if (!p) throw new Error(`picture ${index} is not in the collection`);
          const r = await get(
            `${base}/v1/collections/${v.id}/pictures/${index}`,
            {
              signal: AbortSignal.timeout(30_000),
            },
          );
          if (!r.ok) throw new Error(`picture ${index}: HTTP ${r.status}`);
          const content = new Uint8Array(await r.arrayBuffer());
          if (toHex(await pictureHash(p.contentType, content)) !== p.hash)
            throw new Error(`picture ${index}: not its hash`);
          return {
            index,
            contentType: p.contentType,
            content,
            proof: await collectionProof(leaves, index),
          };
        }),
      );
    },
  };
}

/** The launch key's x-only public key (BIP340). */
export const xOnlyKey = (secret: Uint8Array) => schnorr.getPublicKey(secret);
/** A key-path P2TR output script (the vault's, the launch key's). */
export const keyPathScript = (xonly: Uint8Array, network = btc.NETWORK) =>
  p2trKey(xonly, network).script;
