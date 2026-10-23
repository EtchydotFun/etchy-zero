import type { esplora } from './bitcoin.ts';
import { fromHex } from './borsh.ts';

/**
 * What a Rune's etching inscribed on Bitcoin: the logo (the inscription's
 * body) and the launch details (ord metadata, field 5: CBOR). Etchy etches
 * every Rune with its logo and `{ name, symbol (the ticker), description,
 * twitter, telegram, website, ... }`, so any site can show a pool's name,
 * ticker and logo from Bitcoin alone. ord links a Rune to inscription
 * `<etching txid>i0`: the first envelope of the etching transaction.
 *
 * Browser-safe, no dependency. Lenient reader: anything it cannot read
 * gives `null`, never a wrong value.
 */
export interface RuneInscription {
  /** `<etching txid>i0` (ordinals.com/inscription/<id>). */
  inscriptionId: string;
  etchingTxid: string;
  contentType: string | null;
  /** ord field 9 (e.g. "br"): the body is compressed; null when plain. */
  contentEncoding: string | null;
  body: Uint8Array | null;
  /** The decoded metadata (CBOR), null when absent or unreadable. */
  metadata: unknown;
}
/** A Rune's launch details from its inscription (Etchy's keys; absent: null). */
export interface RuneLaunchInfo {
  name: string | null;
  /** The ticker (metadata key `symbol`). */
  ticker: string | null;
  description: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  /** A high-resolution copy of the logo (IPFS), when given. */
  image: string | null;
  /** The same Rune's Solana mint, when given. */
  solanaMint: string | null;
  /** Who gets the creator part of the fees: HOLDERS, ROUTED or CREATOR. */
  fees: 'HOLDERS' | 'ROUTED' | 'CREATOR' | null;
  /** ROUTED / CREATOR: the wallets and their shares (basis points of it), at launch. */
  feeRoute: { address: string; bps: number }[] | null;
  /** The wallet that launched it, and what it paid with. */
  deployer: string | null;
  paidWith: 'BTC' | 'SOL' | null;
}
/** `bc1q… 60%, bc1p… 40%` -> entries (null unless it adds up to 100%). */
export function parseFeeRoute(
  text: string | null,
): { address: string; bps: number }[] | null {
  if (!text) return null;
  const out: { address: string; bps: number }[] = [];
  for (const part of text.split(',')) {
    const m =
      /^\s*([13a-zA-HJ-NP-Z0-9]{25,90}) (\d{1,3}(?:\.\d{1,2})?)%\s*$/.exec(
        part,
      );
    if (!m) return null;
    out.push({ address: m[1], bps: Math.round(Number(m[2]) * 100) });
  }
  return out.reduce((s, x) => s + x.bps, 0) === 10_000 ? out : null;
}

const OP_0 = 0x00;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;
const OP_IF = 0x63;
const OP_ENDIF = 0x68;
const TAG_CONTENT_TYPE = 1;
const TAG_METADATA = 5;
const TAG_CONTENT_ENCODING = 9;
const ORD = [0x6f, 0x72, 0x64]; // "ord"
const utf8 = new TextDecoder('utf-8', { fatal: true });
const text = (b: Uint8Array) => {
  try {
    return utf8.decode(b);
  } catch {
    return null;
  }
};
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

type Token = { push: Uint8Array } | { op: number };
/** Tapscript tokens; null on a truncated push. */
function tokens(script: Uint8Array): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i++];
    let n = -1;
    if (op === OP_0) n = 0;
    else if (op >= 1 && op <= 75) n = op;
    else if (op === OP_PUSHDATA1 && i + 1 <= script.length) n = script[i++];
    else if (op === OP_PUSHDATA2 && i + 2 <= script.length) {
      n = script[i] | (script[i + 1] << 8);
      i += 2;
    } else if (op === OP_PUSHDATA4 && i + 4 <= script.length) {
      n =
        (script[i] |
          (script[i + 1] << 8) |
          (script[i + 2] << 16) |
          (script[i + 3] << 24)) >>>
        0;
      i += 4;
    } else if (op >= OP_PUSHDATA1 && op <= OP_PUSHDATA4) return null;
    if (n < 0) {
      out.push({ op });
      continue;
    }
    if (i + n > script.length) return null;
    out.push({ push: script.subarray(i, i + n) });
    i += n;
  }
  return out;
}

interface Envelope {
  fields: Map<number, Uint8Array[]>;
  body: Uint8Array | null;
}
/** ord envelopes (`OP_FALSE OP_IF "ord" ... OP_ENDIF`) in one tapscript. */
export function tapscriptEnvelopes(script: Uint8Array): Envelope[] {
  const t = tokens(script);
  if (!t) return [];
  const out: Envelope[] = [];
  for (let i = 0; i + 2 < t.length; i++) {
    const [a, b, c] = [t[i], t[i + 1], t[i + 2]];
    if (
      !('push' in a) ||
      a.push.length !== 0 ||
      !('op' in b) ||
      b.op !== OP_IF ||
      !('push' in c) ||
      c.push.length !== 3 ||
      ORD.some((x, k) => c.push[k] !== x)
    )
      continue;
    const payload: Uint8Array[] = [];
    let j = i + 3;
    let ok = true;
    for (; j < t.length; j++) {
      const x = t[j];
      if ('op' in x) {
        ok = x.op === OP_ENDIF;
        break;
      }
      payload.push(x.push);
    }
    if (!ok || j >= t.length) continue;
    const fields = new Map<number, Uint8Array[]>();
    let body: Uint8Array | null = null;
    for (let k = 0; k < payload.length; k += 2) {
      const tag = payload[k];
      if (tag.length === 0) {
        body = concat(payload.slice(k + 1));
        break;
      }
      if (k + 1 >= payload.length) break;
      if (tag.length !== 1) continue;
      fields.set(tag[0], [...(fields.get(tag[0]) ?? []), payload[k + 1]]);
    }
    out.push({ fields, body });
    i = j;
  }
  return out;
}

/** CBOR (RFC 8949) for metadata: definite lengths only, at most 8 levels deep. */
export function decodeCbor(bytes: Uint8Array): unknown {
  let i = 0;
  const need = (n: number) => {
    if (i + n > bytes.length) throw new Error('cbor: truncated');
  };
  const length = (info: number): number => {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
    if (!size) throw new Error('cbor: unsupported length');
    need(size);
    let n = 0;
    for (let k = 0; k < size; k++) n = n * 256 + bytes[i++];
    return n;
  };
  const item = (depth: number): unknown => {
    if (depth > 8) throw new Error('cbor: too deep');
    need(1);
    const b = bytes[i++];
    const major = b >> 5;
    const info = b & 0x1f;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22 || info === 23) return null;
      throw new Error('cbor: unsupported simple value');
    }
    const n = length(info);
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2 || major === 3) {
      need(n);
      const raw = bytes.subarray(i, i + n);
      i += n;
      if (major === 2) return Uint8Array.from(raw);
      const s = text(raw);
      if (s === null) throw new Error('cbor: bad text');
      return s;
    }
    if (major === 4) {
      if (n > 1_000) throw new Error('cbor: too long');
      return Array.from({ length: n }, () => item(depth + 1));
    }
    if (major === 5) {
      if (n > 1_000) throw new Error('cbor: too long');
      const m: Record<string, unknown> = {};
      for (let k = 0; k < n; k++) {
        const key = item(depth + 1);
        const value = item(depth + 1);
        if (
          typeof key === 'string' &&
          key !== '__proto__' &&
          key !== 'constructor' &&
          key !== 'prototype'
        )
          m[key] = value;
      }
      return m;
    }
    if (major === 6) {
      length(info); // a tag: keep the tagged value
      return item(depth + 1);
    }
    throw new Error('cbor: unsupported');
  };
  const v = item(0);
  if (i !== bytes.length) throw new Error('cbor: trailing bytes');
  return v;
}

/**
 * The first inscription of a transaction, from its inputs' witnesses (hex
 * items, as Esplora gives them). Script-path spends only: the tapscript is
 * the item before the control block (an annex, if any, is skipped).
 */
export function firstInscription(
  txid: string,
  witnesses: string[][],
): RuneInscription | null {
  for (const w of witnesses) {
    let items = w;
    if (items.length >= 2 && /^50/i.test(items[items.length - 1]))
      items = items.slice(0, -1);
    if (items.length < 2) continue;
    const control = items[items.length - 1];
    if (control.length < 66 || (control.length / 2 - 33) % 32 !== 0) continue;
    let script: Uint8Array;
    try {
      script = fromHex(items[items.length - 2]);
    } catch {
      continue;
    }
    const e = tapscriptEnvelopes(script)[0];
    if (!e) continue;
    const one = (tag: number) => {
      const v = e.fields.get(tag)?.[0];
      return v ? text(v) : null;
    };
    const md = e.fields.get(TAG_METADATA);
    let metadata: unknown = null;
    if (md)
      try {
        metadata = decodeCbor(concat(md));
      } catch {
        metadata = null;
      }
    return {
      inscriptionId: `${txid}i0`,
      etchingTxid: txid,
      contentType: one(TAG_CONTENT_TYPE),
      contentEncoding: one(TAG_CONTENT_ENCODING),
      body: e.body,
      metadata,
    };
  }
  return null;
}

/** Etchy's launch keys from inscription metadata (anything else: null). */
export function launchInfoOf(metadata: unknown): RuneLaunchInfo {
  const m =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const str = (k: string, max = 512) => {
    const v = m[k];
    if (typeof v !== 'string') return null;
    const s = v.trim();
    // No control characters (invisible text) in names shown to people.
    if (!s || s.length > max || [...s].some((ch) => ch.charCodeAt(0) < 0x20))
      return null;
    return s;
  };
  return {
    name: str('name', 64),
    ticker: str('symbol', 32),
    description: str('description', 1_000),
    twitter: str('twitter'),
    telegram: str('telegram'),
    website: str('website'),
    image: str('image'),
    solanaMint: str('solanaMint', 44),
    fees:
      str('fees') === 'HOLDERS'
        ? 'HOLDERS'
        : str('fees') === 'ROUTED'
          ? 'ROUTED'
          : str('fees') === 'CREATOR'
            ? 'CREATOR'
            : null,
    feeRoute: parseFeeRoute(str('feeRoute')),
    deployer: str('deployer', 90),
    paidWith:
      str('paidWith') === 'BTC'
        ? 'BTC'
        : str('paidWith') === 'SOL'
          ? 'SOL'
          : null,
  };
}

type Esplora = Pick<ReturnType<typeof esplora>, 'get'>;
/**
 * A Rune's etching inscription, from any Esplora server (null: the etching
 * inscribed nothing). Etchings never change: cache the answer forever.
 */
export async function runeInscription(o: {
  rune: { block: bigint | number; tx: number };
  bitcoin: Esplora;
}): Promise<RuneInscription | null> {
  const hash = String(
    (await o.bitcoin.get(`/block-height/${o.rune.block}`, true)) ?? '',
  ).trim();
  if (!/^[0-9a-f]{64}$/.test(hash))
    throw new Error(`no block at ${o.rune.block}`);
  const txid = String(
    (await o.bitcoin.get(`/block/${hash}/txid/${o.rune.tx}`, true)) ?? '',
  ).trim();
  if (!/^[0-9a-f]{64}$/.test(txid))
    throw new Error(`no transaction ${o.rune.block}:${o.rune.tx}`);
  const tx = (await o.bitcoin.get(`/tx/${txid}`)) as {
    vin?: { witness?: string[] }[];
  } | null;
  if (!tx?.vin) throw new Error(`transaction ${txid} not found`);
  return firstInscription(
    txid,
    tx.vin.map((v) => v.witness ?? []),
  );
}

const MAGIC: [string, (b: Uint8Array) => boolean][] = [
  [
    'image/png',
    (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  ],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  [
    'image/webp',
    (b) =>
      text(b.subarray(0, 4)) === 'RIFF' && text(b.subarray(8, 12)) === 'WEBP',
  ],
  ['image/gif', (b) => text(b.subarray(0, 4)) === 'GIF8'],
  ['image/avif', (b) => text(b.subarray(4, 12)) === 'ftypavif'],
];
/**
 * The inscription's logo when it is safe to show as an image: PNG, JPEG,
 * WebP, GIF or AVIF whose bytes really are that type, not compressed, at
 * most `maxBytes`. (SVG and HTML are never shown: they can run scripts.)
 */
export function inscriptionLogo(
  i: RuneInscription | null,
  maxBytes = 400_000,
): { contentType: string; bytes: Uint8Array } | null {
  if (!i?.body || i.contentEncoding || i.body.length < 12) return null;
  if (i.body.length > maxBytes) return null;
  const type = (i.contentType ?? '').split(';')[0].trim().toLowerCase();
  const m = MAGIC.find(([t]) => t === type);
  return m && m[1](i.body) ? { contentType: type, bytes: i.body } : null;
}
