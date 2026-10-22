import { PublicKey } from '@solana/web3.js';

/** The IDL type language (Anchor 0.30+ IDL). */
export type IdlType =
  | string
  | { vec: IdlType }
  | { array: readonly [IdlType, number] }
  | { option: IdlType }
  | { defined: { name: string } };
export interface IdlField {
  readonly name: string;
  readonly type: IdlType;
}
export interface IdlTypeDef {
  readonly name: string;
  readonly type:
    | { readonly kind: 'struct'; readonly fields: readonly IdlField[] }
    | { readonly kind: 'enum'; readonly variants: readonly { name: string }[] };
}
export interface IdlLike {
  readonly address: string;
  readonly instructions: readonly {
    readonly name: string;
    readonly discriminator: readonly number[];
    readonly accounts: readonly {
      readonly name: string;
      readonly writable?: boolean;
      readonly signer?: boolean;
      readonly optional?: boolean;
      readonly address?: string;
    }[];
    readonly args: readonly IdlField[];
  }[];
  readonly accounts: readonly {
    readonly name: string;
    readonly discriminator: readonly number[];
  }[];
  readonly events: readonly {
    readonly name: string;
    readonly discriminator: readonly number[];
  }[];
  readonly errors?: readonly {
    readonly code: number;
    readonly name: string;
    readonly msg?: string;
  }[];
  readonly types: readonly IdlTypeDef[];
}

const UINTS: Record<string, number> = {
  u8: 1,
  u16: 2,
  u32: 4,
  u64: 8,
  u128: 16,
};
const SINTS: Record<string, number> = {
  i8: 1,
  i16: 2,
  i32: 4,
  i64: 8,
  i128: 16,
};
/** Integers wider than 32 bits are bigint; the rest numbers. */
const isBig = (bytes: number) => bytes > 4;

export class Writer {
  private parts: Uint8Array[] = [];
  bytes(b: Uint8Array) {
    this.parts.push(Uint8Array.from(b));
  }
  uint(v: bigint | number, bytes: number, path = '') {
    let n = BigInt(v);
    if (n < 0n || n >= 1n << BigInt(bytes * 8))
      throw new Error(`out of range: ${v} (${bytes} bytes ${path})`);
    const b = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) {
      b[i] = Number(n & 0xffn);
      n >>= 8n;
    }
    this.parts.push(b);
  }
  done(): Uint8Array {
    const len = this.parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(len);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

export class Reader {
  at = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  take(n: number): Uint8Array {
    if (this.at + n > this.b.length) throw new Error('account data too short');
    const s = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return s;
  }
  uint(bytes: number): bigint {
    const s = this.take(bytes);
    let n = 0n;
    for (let i = bytes - 1; i >= 0; i--) n = (n << 8n) | BigInt(s[i]);
    return n;
  }
}

const typeDef = (idl: IdlLike, name: string) => {
  const t = idl.types.find((x) => x.name === name);
  if (!t) throw new Error(`type ${name} not in the IDL`);
  return t;
};

export function encodeType(
  idl: IdlLike,
  w: Writer,
  t: IdlType,
  v: unknown,
  path: string,
): void {
  if (typeof t === 'string') {
    if (t in UINTS) return w.uint(v as bigint | number, UINTS[t], path);
    if (t in SINTS) {
      const bits = BigInt(SINTS[t] * 8);
      const n = BigInt(v as bigint | number);
      if (n < -(1n << (bits - 1n)) || n >= 1n << (bits - 1n))
        throw new Error(`out of range: ${n} (${t} ${path})`);
      return w.uint(n < 0n ? n + (1n << bits) : n, SINTS[t], path);
    }
    if (t === 'bool') return w.uint(v ? 1 : 0, 1);
    if (t === 'pubkey')
      return w.bytes(new PublicKey(v as string | PublicKey).toBytes());
    if (t === 'bytes') {
      const b = Uint8Array.from(v as Uint8Array);
      w.uint(b.length, 4);
      return w.bytes(b);
    }
    if (t === 'string') {
      const b = new TextEncoder().encode(v as string);
      w.uint(b.length, 4);
      return w.bytes(b);
    }
    throw new Error(`type ${t} not supported (${path})`);
  }
  if ('vec' in t) {
    const a = v as unknown[];
    w.uint(a.length, 4);
    a.forEach((x, i) => encodeType(idl, w, t.vec, x, `${path}[${i}]`));
    return;
  }
  if ('array' in t) {
    const [inner, n] = t.array;
    if (inner === 'u8') {
      const b = Uint8Array.from(v as Uint8Array);
      if (b.length !== n)
        throw new Error(`${path}: ${b.length} bytes, want ${n}`);
      return w.bytes(b);
    }
    const a = v as unknown[];
    if (a.length !== n)
      throw new Error(`${path}: ${a.length} items, want ${n}`);
    a.forEach((x, i) => encodeType(idl, w, inner, x, `${path}[${i}]`));
    return;
  }
  if ('option' in t) {
    if (v === null || v === undefined) return w.uint(0, 1);
    w.uint(1, 1);
    return encodeType(idl, w, t.option, v, path);
  }
  const def = typeDef(idl, t.defined.name);
  if (def.type.kind !== 'struct')
    throw new Error(`type ${t.defined.name} not supported`);
  const o = v as Record<string, unknown>;
  for (const f of def.type.fields) {
    if (!(f.name in o)) throw new Error(`${path}.${f.name} missing`);
    encodeType(idl, w, f.type, o[f.name], `${path}.${f.name}`);
  }
}

export function decodeType(idl: IdlLike, r: Reader, t: IdlType): unknown {
  if (typeof t === 'string') {
    if (t in UINTS) {
      const n = r.uint(UINTS[t]);
      return isBig(UINTS[t]) ? n : Number(n);
    }
    if (t in SINTS) {
      const bytes = SINTS[t];
      const bits = BigInt(bytes * 8);
      let n = r.uint(bytes);
      if (n >= 1n << (bits - 1n)) n -= 1n << bits;
      return isBig(bytes) ? n : Number(n);
    }
    if (t === 'bool') {
      const b = r.take(1)[0];
      if (b > 1) throw new Error('bad bool');
      return b === 1;
    }
    if (t === 'pubkey') return new PublicKey(r.take(32));
    if (t === 'bytes') return Uint8Array.from(r.take(Number(r.uint(4))));
    if (t === 'string')
      return new TextDecoder().decode(r.take(Number(r.uint(4))));
    throw new Error(`type ${t} not supported`);
  }
  if ('vec' in t) {
    const n = Number(r.uint(4));
    return Array.from({ length: n }, () => decodeType(idl, r, t.vec));
  }
  if ('array' in t) {
    const [inner, n] = t.array;
    if (inner === 'u8') return Uint8Array.from(r.take(n));
    return Array.from({ length: n }, () => decodeType(idl, r, inner));
  }
  if ('option' in t) {
    const some = r.take(1)[0];
    return some === 0 ? null : decodeType(idl, r, t.option);
  }
  const def = typeDef(idl, t.defined.name);
  if (def.type.kind !== 'struct')
    throw new Error(`type ${t.defined.name} not supported`);
  const o: Record<string, unknown> = {};
  for (const f of def.type.fields) o[f.name] = decodeType(idl, r, f.type);
  return o;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Base58 (account filters take base58 bytes). */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}

export const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(s: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/i.test(s)) throw new Error('not hex');
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const w = new Writer();
  for (const p of parts) w.bytes(p);
  return w.done();
}
export function le(v: bigint | number, bytes: number): Uint8Array {
  const w = new Writer();
  w.uint(v, bytes);
  return w.done();
}
