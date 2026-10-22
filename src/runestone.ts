/**
 * ord's Runestone rules (no dependencies): decipher, names, ids. The
 * keeper uses it to follow a pool's Rune through Bitcoin transactions
 * exactly like the program does.
 */
// Runes protocol primitives for Etchy (encoding, decoding, names, commitment).
//
// Port of the protocol rules in the official `ord` repository
// (https://github.com/ordinals/ord, crates/ordinals, analysed at commit
// 03c9b87b14fe1e2c38191b860a08988345ec4e5f). `ord` is released under CC0 1.0
// Universal; attribution is retained voluntarily. Behaviour is verified against
// ord's own test vectors. Pure functions only: no key, signing, network or
// broadcast capability lives here.

export const U128_MAX = (1n << 128n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = (1n << 32n) - 1n;

export const TAG = {
  Body: 0n,
  Flags: 2n,
  Rune: 4n,
  Premine: 6n,
  Cap: 8n,
  Amount: 10n,
  HeightStart: 12n,
  HeightEnd: 14n,
  OffsetStart: 16n,
  OffsetEnd: 18n,
  Mint: 20n,
  Pointer: 22n,
  Cenotaph: 126n,
  Divisibility: 1n,
  Spacers: 3n,
  Symbol: 5n,
  Nop: 127n,
} as const;
export const FLAG = {
  Etching: 1n << 0n,
  Terms: 1n << 1n,
  Turbo: 1n << 2n,
  Cenotaph: 1n << 127n,
} as const;

export const OP_RETURN = 0x6a;
export const OP_PUSHNUM_13 = 0x5d; // Runestone magic number
export const MAX_DIVISIBILITY = 38;
export const MAX_SPACERS = 0b00000111_11111111_11111111_11111111;
export const COMMIT_CONFIRMATIONS = 6;
export const MAX_STANDARD_OP_RETURN_SIZE = 83;
export const TARGET_POSTAGE_SATS = 10_000n;
export const RESERVED_RUNE = 6402364363415443603228541259936211926n;
const SUBSIDY_HALVING_INTERVAL = 210_000;
const UNLOCKED = 12;
const UNLOCK_INTERVAL = SUBSIDY_HALVING_INTERVAL / 12;
const STEPS = [
  0n,
  26n,
  702n,
  18278n,
  475254n,
  12356630n,
  321272406n,
  8353082582n,
  217180147158n,
  5646683826134n,
  146813779479510n,
  3817158266467286n,
  99246114928149462n,
  2580398988131886038n,
  67090373691429037014n,
  1744349715977154962390n,
  45353092615406029022166n,
  1179180408000556754576342n,
  30658690608014475618984918n,
  797125955808376366093607894n,
  20725274851017785518433805270n,
  538857146126462423479278937046n,
  14010285799288023010461252363222n,
  364267430781488598271992561443798n,
  9470953200318703555071806597538774n,
  246244783208286292431866971536008150n,
  6402364363415443603228541259936211926n,
  166461473448801533683942072758341510102n,
];

// ---------------------------------------------------------------------------
// LEB128 varints (u128), identical to ord::varint.
// ---------------------------------------------------------------------------
export class VarintError extends Error {
  readonly kind: 'Overlong' | 'Overflow' | 'Unterminated';
  constructor(kind: 'Overlong' | 'Overflow' | 'Unterminated') {
    super(`varint ${kind}`);
    this.kind = kind;
  }
}
export function varintEncode(value: bigint): number[] {
  if (value < 0n || value > U128_MAX) throw new Error('varint out of range');
  const out: number[] = [];
  let n = value;
  while (n >> 7n > 0n) {
    out.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
  return out;
}
export function varintDecode(
  buffer: Uint8Array,
  start = 0,
): [value: bigint, length: number] {
  let n = 0n;
  for (let i = 0; start + i < buffer.length; i++) {
    if (i > 18) throw new VarintError('Overlong');
    const byte = buffer[start + i];
    const value = BigInt(byte & 0x7f);
    if (i === 18 && (value & 0b0111_1100n) !== 0n)
      throw new VarintError('Overflow');
    n |= value << BigInt(7 * i);
    if ((byte & 0x80) === 0) return [n, i + 1];
  }
  throw new VarintError('Unterminated');
}

// ---------------------------------------------------------------------------
// Rune names.
// ---------------------------------------------------------------------------
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function parseRune(name: string): bigint {
  if (typeof name !== 'string' || name.length === 0)
    throw new Error('Invalid Rune name');
  let x = 0n;
  for (let i = 0; i < name.length; i++) {
    if (i > 0) x += 1n;
    x *= 26n;
    const c = name.charCodeAt(i);
    if (c < 65 || c > 90) throw new Error('Invalid Rune name character');
    x += BigInt(c - 65);
    if (x > U128_MAX) throw new Error('Rune name out of range');
  }
  return x;
}
export function formatRune(value: bigint): string {
  if (value < 0n || value > U128_MAX) throw new Error('Rune out of range');
  if (value === U128_MAX) return 'BCGDENLQRQWDSLRUGSNLBTMFIJAV';
  let n = value + 1n;
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number((n - 1n) % 26n)] + s;
    n = (n - 1n) / 26n;
  }
  return s;
}
export interface SpacedRune {
  rune: bigint;
  name: string;
  spacers: number;
}
/** ord SpacedRune::from_str: `.` or `•` between letters sets spacer bits. */
export function parseSpacedRune(input: string): SpacedRune {
  let rune = '';
  let spacers = 0;
  for (const c of input) {
    if (c >= 'A' && c <= 'Z') rune += c;
    else if (c === '.' || c === '•') {
      if (rune.length === 0) throw new Error('Leading spacer');
      const flag = 1 << (rune.length - 1);
      if (rune.length - 1 > 31 || (spacers & flag) !== 0)
        throw new Error('Double spacer');
      spacers = (spacers | flag) >>> 0;
    } else throw new Error('Invalid Rune name character');
  }
  const bitLength = spacers === 0 ? 0 : 32 - Math.clz32(spacers);
  if (bitLength >= rune.length) throw new Error('Trailing spacer');
  return { rune: parseRune(rune), name: rune, spacers };
}
export function formatSpacedRune(rune: bigint, spacers: number): string {
  const name = formatRune(rune);
  let out = '';
  for (let i = 0; i < name.length; i++) {
    out += name[i];
    if (i < name.length - 1 && (spacers & (1 << i)) !== 0) out += '•';
  }
  return out;
}
export function isReservedRune(rune: bigint): boolean {
  return rune >= RESERVED_RUNE;
}
/** M55: chosen names have at most this many letters (27+ is the reserved range). */
export const MAX_CHOSEN_RUNE_LETTERS = 26;
/**
 * M55: a creator's chosen Rune name as typed (any case; spaces, dots or `•`
 * between words) -> ord's canonical spaced name, e.g. `doge on btc` ->
 * `DOGE•ON•BTC`. Throws Error(code) on anything else.
 */
export function canonicalSpacedRuneName(input: unknown): string {
  if (typeof input !== 'string') throw new Error('RUNE_NAME_INVALID');
  const typed = input
    .trim()
    .toUpperCase()
    .replace(/[\s.\u2022]+/g, '\u2022');
  if (!typed || typed.startsWith('\u2022') || typed.endsWith('\u2022'))
    throw new Error('RUNE_NAME_INVALID');
  if (!/^[A-Z\u2022]+$/.test(typed)) throw new Error('RUNE_NAME_INVALID');
  const letters = typed.replace(/\u2022/g, '');
  if (letters.length > MAX_CHOSEN_RUNE_LETTERS)
    throw new Error('RUNE_NAME_TOO_LONG');
  let spaced: SpacedRune;
  try {
    spaced = parseSpacedRune(typed);
  } catch {
    throw new Error('RUNE_NAME_INVALID');
  }
  if (isReservedRune(spaced.rune)) throw new Error('RUNE_NAME_INVALID');
  return formatSpacedRune(spaced.rune, spaced.spacers);
}
/**
 * M55: which names are unlocked at `height`: every name of `allFrom` letters
 * or more, and some of `someFrom` letters (ord unlocks the alphabet's end
 * first within a length).
 */
export function runeNameUnlock(height: number): {
  minimum: bigint;
  allFrom: number;
  someFrom: number;
} {
  const minimum = minimumRuneAtHeight(height);
  if (minimum === 0n) return { minimum, allFrom: 1, someFrom: 1 };
  const len = formatRune(minimum).length;
  return {
    minimum,
    allFrom: minimum === STEPS[len - 1] ? len : len + 1,
    someFrom: len,
  };
}
/**
 * ord `Rune::reserved(block, tx)` (crates/ordinals/src/rune.rs):
 * RESERVED + ((block << 32) | tx). This is the name ord assigns to an etching
 * whose Runestone omits the Rune tag. It is known only once the etching tx is
 * confirmed at (block, tx index) and is identical to the Rune ID coordinates.
 */
export function reservedRune(block: bigint, tx: bigint): bigint {
  if (
    block < 0n ||
    block > 0xffff_ffff_ffff_ffffn ||
    tx < 0n ||
    tx > 0xffff_ffffn
  )
    throw new Error('Invalid Rune ID');
  return RESERVED_RUNE + ((block << 32n) | tx);
}
export function reservedRuneName(block: bigint, tx: bigint): string {
  return formatRune(reservedRune(block, tx));
}
/** Minimal little-endian bytes of the Rune value, pushed in the reveal tapscript. */
export function runeCommitment(rune: bigint): Uint8Array {
  if (rune < 0n || rune > U128_MAX) throw new Error('Rune out of range');
  const bytes: number[] = [];
  let n = rune;
  for (let i = 0; i < 16; i++) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return Uint8Array.from(bytes.slice(0, end));
}
/** Mainnet Rune::minimum_at_height (first Rune height = 840,000). */
export function minimumRuneAtHeight(height: number): bigint {
  if (!Number.isSafeInteger(height) || height < 0)
    throw new Error('Invalid height');
  const offset = Math.min(height + 1, 0xffffffff);
  const start = SUBSIDY_HALVING_INTERVAL * 4;
  const end = start + SUBSIDY_HALVING_INTERVAL;
  if (offset < start) return STEPS[UNLOCKED];
  if (offset >= end) return 0n;
  const progress = offset - start;
  const length = Math.max(0, UNLOCKED - Math.floor(progress / UNLOCK_INTERVAL));
  const endStep = STEPS[length - 1];
  const startStep = STEPS[length];
  const remainder = BigInt(progress % UNLOCK_INTERVAL);
  return (
    startStep - ((startStep - endStep) * remainder) / BigInt(UNLOCK_INTERVAL)
  );
}

// ---------------------------------------------------------------------------
// Runestone model, encipher and decipher.
// ---------------------------------------------------------------------------
export interface RuneId {
  block: bigint;
  tx: bigint;
}
export interface Terms {
  amount?: bigint;
  cap?: bigint;
  heightStart?: bigint;
  heightEnd?: bigint;
  offsetStart?: bigint;
  offsetEnd?: bigint;
}
export interface Etching {
  divisibility?: number;
  premine?: bigint;
  rune?: bigint;
  spacers?: number;
  symbol?: string;
  terms?: Terms;
  turbo: boolean;
}
export interface Edict {
  id: RuneId;
  amount: bigint;
  output: number;
}
export interface Runestone {
  edicts: Edict[];
  etching?: Etching;
  mint?: RuneId;
  pointer?: number;
}
export type Flaw =
  | 'EdictOutput'
  | 'EdictRuneId'
  | 'InvalidScript'
  | 'Opcode'
  | 'SupplyOverflow'
  | 'TrailingIntegers'
  | 'TruncatedField'
  | 'UnrecognizedEvenTag'
  | 'UnrecognizedFlag'
  | 'Varint';
export type Artifact =
  | { kind: 'runestone'; runestone: Runestone }
  | { kind: 'cenotaph'; flaw: Flaw; etchingRune?: bigint; mint?: RuneId };

function pushData(data: Uint8Array): number[] {
  const n = data.length;
  if (n <= 75) return [n, ...data];
  if (n <= 0xff) return [0x4c, n, ...data];
  if (n <= 0xffff) return [0x4d, n & 0xff, n >> 8, ...data];
  throw new Error('Runestone payload too large');
}
function encodeTag(tag: bigint, value: bigint, out: number[]) {
  out.push(...varintEncode(tag), ...varintEncode(value));
}
export function supplyOf(etching: Etching): bigint | null {
  const premine = etching.premine ?? 0n;
  const cap = etching.terms?.cap ?? 0n;
  const amount = etching.terms?.amount ?? 0n;
  const minted = cap * amount;
  if (minted > U128_MAX) return null;
  const total = premine + minted;
  return total > U128_MAX ? null : total;
}
/** ord Runestone::encipher → OP_RETURN OP_13 <payload>. */
export function encipherRunestone(runestone: Runestone): Uint8Array {
  const payload: number[] = [];
  const e = runestone.etching;
  if (e) {
    let flags = FLAG.Etching;
    if (e.terms) flags |= FLAG.Terms;
    if (e.turbo) flags |= FLAG.Turbo;
    encodeTag(TAG.Flags, flags, payload);
    if (e.rune !== undefined) encodeTag(TAG.Rune, e.rune, payload);
    if (e.divisibility !== undefined)
      encodeTag(TAG.Divisibility, BigInt(e.divisibility), payload);
    if (e.spacers !== undefined)
      encodeTag(TAG.Spacers, BigInt(e.spacers), payload);
    if (e.symbol !== undefined)
      encodeTag(TAG.Symbol, BigInt(e.symbol.codePointAt(0)!), payload);
    if (e.premine !== undefined) encodeTag(TAG.Premine, e.premine, payload);
    if (e.terms) {
      const t = e.terms;
      if (t.amount !== undefined) encodeTag(TAG.Amount, t.amount, payload);
      if (t.cap !== undefined) encodeTag(TAG.Cap, t.cap, payload);
      if (t.heightStart !== undefined)
        encodeTag(TAG.HeightStart, t.heightStart, payload);
      if (t.heightEnd !== undefined)
        encodeTag(TAG.HeightEnd, t.heightEnd, payload);
      if (t.offsetStart !== undefined)
        encodeTag(TAG.OffsetStart, t.offsetStart, payload);
      if (t.offsetEnd !== undefined)
        encodeTag(TAG.OffsetEnd, t.offsetEnd, payload);
    }
  }
  if (runestone.mint) {
    encodeTag(TAG.Mint, runestone.mint.block, payload);
    encodeTag(TAG.Mint, runestone.mint.tx, payload);
  }
  if (runestone.pointer !== undefined)
    encodeTag(TAG.Pointer, BigInt(runestone.pointer), payload);
  if (runestone.edicts.length) {
    payload.push(...varintEncode(TAG.Body));
    const edicts = [...runestone.edicts].sort((a, b) =>
      a.id.block === b.id.block
        ? Number(a.id.tx - b.id.tx)
        : a.id.block < b.id.block
          ? -1
          : 1,
    );
    let previous: RuneId = { block: 0n, tx: 0n };
    for (const edict of edicts) {
      const block = edict.id.block - previous.block;
      const tx = block === 0n ? edict.id.tx - previous.tx : edict.id.tx;
      payload.push(
        ...varintEncode(block),
        ...varintEncode(tx),
        ...varintEncode(edict.amount),
        ...varintEncode(BigInt(edict.output)),
      );
      previous = edict.id;
    }
  }
  return Uint8Array.from([
    OP_RETURN,
    OP_PUSHNUM_13,
    ...(payload.length ? pushData(Uint8Array.from(payload)) : []),
  ]);
}

type Payload = { valid: Uint8Array } | { flaw: Flaw } | null;
function runestonePayload(scripts: Uint8Array[]): Payload {
  for (const script of scripts) {
    if (script.length < 2 || script[0] !== OP_RETURN) continue;
    if (script[1] !== OP_PUSHNUM_13) continue;
    const parts: number[] = [];
    let i = 2;
    while (i < script.length) {
      const op = script[i];
      let length: number;
      let offset: number;
      if (op <= 0x4b) {
        length = op;
        offset = 1;
      } else if (op === 0x4c) {
        if (i + 1 >= script.length) return { flaw: 'InvalidScript' };
        length = script[i + 1];
        offset = 2;
      } else if (op === 0x4d) {
        if (i + 2 >= script.length) return { flaw: 'InvalidScript' };
        length = script[i + 1] | (script[i + 2] << 8);
        offset = 3;
      } else if (op === 0x4e) {
        if (i + 4 >= script.length) return { flaw: 'InvalidScript' };
        length =
          (script[i + 1] |
            (script[i + 2] << 8) |
            (script[i + 3] << 16) |
            (script[i + 4] << 24)) >>>
          0;
        offset = 5;
      } else return { flaw: 'Opcode' };
      if (i + offset + length > script.length) return { flaw: 'InvalidScript' };
      parts.push(...script.subarray(i + offset, i + offset + length));
      i += offset + length;
    }
    return { valid: Uint8Array.from(parts) };
  }
  return null;
}
function nextRuneId(id: RuneId, block: bigint, tx: bigint): RuneId | null {
  const b = id.block + block;
  if (block > U64_MAX || b > U64_MAX) return null;
  const t = block === 0n ? id.tx + tx : tx;
  if (tx > U32_MAX || t > U32_MAX) return null;
  if (b === 0n && t > 0n) return null;
  return { block: b, tx: t };
}
function take<T>(
  fields: Map<bigint, bigint[]>,
  tag: bigint,
  n: number,
  parse: (values: bigint[]) => T | undefined,
): T | undefined {
  const field = fields.get(tag);
  if (!field || field.length < n) return undefined;
  const value = parse(field.slice(0, n));
  if (value === undefined) return undefined;
  field.splice(0, n);
  if (!field.length) fields.delete(tag);
  return value;
}
function codepoint(value: bigint): string | undefined {
  if (value > 0x10ffffn || (value >= 0xd800n && value <= 0xdfffn))
    return undefined;
  return String.fromCodePoint(Number(value));
}
/** ord Runestone::decipher over a transaction's output scripts. */
export function decipherRunestone(
  outputScripts: Uint8Array[],
): Artifact | null {
  const payload = runestonePayload(outputScripts);
  if (!payload) return null;
  if ('flaw' in payload) return { kind: 'cenotaph', flaw: payload.flaw };
  const integers: bigint[] = [];
  try {
    for (let i = 0; i < payload.valid.length;) {
      const [value, length] = varintDecode(payload.valid, i);
      integers.push(value);
      i += length;
    }
  } catch {
    return { kind: 'cenotaph', flaw: 'Varint' };
  }
  let flaw: Flaw | undefined;
  const edicts: Edict[] = [];
  const fields = new Map<bigint, bigint[]>();
  for (let i = 0; i < integers.length; i += 2) {
    const tag = integers[i];
    if (tag === TAG.Body) {
      let id: RuneId = { block: 0n, tx: 0n };
      const rest = integers.slice(i + 1);
      for (let j = 0; j < rest.length; j += 4) {
        const chunk = rest.slice(j, j + 4);
        if (chunk.length !== 4) {
          flaw ??= 'TrailingIntegers';
          break;
        }
        const next = nextRuneId(id, chunk[0], chunk[1]);
        if (!next) {
          flaw ??= 'EdictRuneId';
          break;
        }
        if (chunk[3] > U32_MAX || chunk[3] > BigInt(outputScripts.length)) {
          flaw ??= 'EdictOutput';
          break;
        }
        id = next;
        edicts.push({ id: next, amount: chunk[2], output: Number(chunk[3]) });
      }
      break;
    }
    if (i + 1 >= integers.length) {
      flaw ??= 'TruncatedField';
      break;
    }
    const list = fields.get(tag) ?? [];
    list.push(integers[i + 1]);
    fields.set(tag, list);
  }
  let flags = take(fields, TAG.Flags, 1, ([f]) => f) ?? 0n;
  const flag = (mask: bigint) => {
    const set = (flags & mask) !== 0n;
    flags &= ~mask;
    return set;
  };
  let etching: Etching | undefined;
  if (flag(FLAG.Etching)) {
    const divisibility = take(fields, TAG.Divisibility, 1, ([d]) =>
      d <= BigInt(MAX_DIVISIBILITY) ? Number(d) : undefined,
    );
    const premine = take(fields, TAG.Premine, 1, ([p]) => p);
    const rune = take(fields, TAG.Rune, 1, ([r]) => r);
    const spacers = take(fields, TAG.Spacers, 1, ([s]) =>
      s <= BigInt(MAX_SPACERS) ? Number(s) : undefined,
    );
    const symbol = take(fields, TAG.Symbol, 1, ([s]) =>
      s <= U32_MAX ? codepoint(s) : undefined,
    );
    let terms: Terms | undefined;
    if (flag(FLAG.Terms)) {
      const u64 = ([v]: bigint[]) => (v <= U64_MAX ? v : undefined);
      terms = {
        cap: take(fields, TAG.Cap, 1, ([v]) => v),
        heightStart: take(fields, TAG.HeightStart, 1, u64),
        heightEnd: take(fields, TAG.HeightEnd, 1, u64),
        amount: take(fields, TAG.Amount, 1, ([v]) => v),
        offsetStart: take(fields, TAG.OffsetStart, 1, u64),
        offsetEnd: take(fields, TAG.OffsetEnd, 1, u64),
      };
      for (const key of Object.keys(terms) as (keyof Terms)[])
        if (terms[key] === undefined) delete terms[key];
    }
    etching = { turbo: flag(FLAG.Turbo) };
    if (divisibility !== undefined) etching.divisibility = divisibility;
    if (premine !== undefined) etching.premine = premine;
    if (rune !== undefined) etching.rune = rune;
    if (spacers !== undefined) etching.spacers = spacers;
    if (symbol !== undefined) etching.symbol = symbol;
    if (terms) etching.terms = terms;
  }
  const mint = take(fields, TAG.Mint, 2, ([block, tx]) =>
    block <= U64_MAX && tx <= U32_MAX && !(block === 0n && tx > 0n)
      ? { block, tx }
      : undefined,
  );
  const pointer = take(fields, TAG.Pointer, 1, ([p]) =>
    p <= U32_MAX && p < BigInt(outputScripts.length) ? Number(p) : undefined,
  );
  if (etching && supplyOf(etching) === null) flaw ??= 'SupplyOverflow';
  if (flags !== 0n) flaw ??= 'UnrecognizedFlag';
  if ([...fields.keys()].some((tag) => tag % 2n === 0n))
    flaw ??= 'UnrecognizedEvenTag';
  if (flaw)
    return {
      kind: 'cenotaph',
      flaw,
      ...(etching?.rune !== undefined ? { etchingRune: etching.rune } : {}),
      ...(mint ? { mint } : {}),
    };
  const runestone: Runestone = { edicts };
  if (etching) runestone.etching = etching;
  if (mint) runestone.mint = mint;
  if (pointer !== undefined) runestone.pointer = pointer;
  return { kind: 'runestone', runestone };
}

/** Integer payload of an enciphered Runestone (for vector comparison). */
export function runestoneIntegers(script: Uint8Array): bigint[] {
  const payload = runestonePayload([script]);
  if (!payload || !('valid' in payload)) throw new Error('Invalid Runestone');
  const out: bigint[] = [];
  for (let i = 0; i < payload.valid.length;) {
    const [value, length] = varintDecode(payload.valid, i);
    out.push(value);
    i += length;
  }
  return out;
}

/**
 * Allocation of a freshly etched Rune's premine in a transaction whose inputs
 * carry no Runes (ord RuneUpdater semantics). Cenotaphs burn everything;
 * otherwise the pointer (or first non-OP_RETURN output) receives unallocated
 * units; allocation to an OP_RETURN output is burned.
 */
export function simulateEtchAllocation(
  outputScripts: Uint8Array[],
  artifact: Artifact | null,
): { allocated: Map<number, bigint>; burned: bigint; etched: bigint } {
  const allocated = new Map<number, bigint>();
  if (!artifact || artifact.kind === 'cenotaph' || !artifact.runestone.etching)
    return { allocated, burned: 0n, etched: 0n };
  const runestone = artifact.runestone;
  const premine = runestone.etching!.premine ?? 0n;
  let unallocated = premine;
  let burned = 0n;
  const isOpReturn = (vout: number) => outputScripts[vout]?.[0] === OP_RETURN;
  for (const edict of runestone.edicts) {
    // Only the etched Rune (id 0:0) can exist in an etch with Rune-free inputs.
    if (edict.id.block !== 0n || edict.id.tx !== 0n) continue;
    const nonOpReturn = outputScripts
      .map((_, vout) => vout)
      .filter((vout) => !isOpReturn(vout));
    if (edict.output === outputScripts.length) {
      if (!nonOpReturn.length) continue;
      const each =
        edict.amount === 0n
          ? unallocated / BigInt(nonOpReturn.length)
          : edict.amount;
      for (const vout of nonOpReturn) {
        const give = each < unallocated ? each : unallocated;
        allocated.set(vout, (allocated.get(vout) ?? 0n) + give);
        unallocated -= give;
      }
      continue;
    }
    const give =
      edict.amount === 0n || edict.amount > unallocated
        ? unallocated
        : edict.amount;
    allocated.set(edict.output, (allocated.get(edict.output) ?? 0n) + give);
    unallocated -= give;
  }
  const target =
    runestone.pointer ??
    outputScripts.findIndex((_, vout) => !isOpReturn(vout));
  if (unallocated > 0n) {
    if (target === undefined || target < 0) burned += unallocated;
    else allocated.set(target, (allocated.get(target) ?? 0n) + unallocated);
  }
  for (const [vout, amount] of [...allocated]) {
    if (isOpReturn(vout)) {
      burned += amount;
      allocated.delete(vout);
    }
  }
  return { allocated, burned, etched: premine };
}

export const runeIdKey = (id: RuneId) => `${id.block}:${id.tx}`;

/**
 * Exact ord `RuneUpdater::index_runes` allocation for a TRANSFER (no etching,
 * no mint): `inputs` are the Rune balances carried by the spent outputs.
 * - Cenotaph: every input Rune is burned (edicts ignored).
 * - Edicts, in order: unknown/absent Rune skipped; `output == outputs.len`
 *   splits among non-OP_RETURN outputs (amount 0 = even split, remainder to
 *   the first ones; else `min(amount, balance)` each); otherwise
 *   `amount 0 = all`, else `min(amount, balance)` to that output.
 * - Remaining balances go to `pointer`, else the first non-OP_RETURN output,
 *   else they are burned. Anything landing on an OP_RETURN output is burned.
 * Etching / mint artifacts are outside this function's scope (refused).
 */
export function simulateRuneTransfer(
  inputs: ReadonlyMap<string, bigint>,
  outputScripts: Uint8Array[],
  artifact: Artifact | null,
): {
  allocated: Map<number, Map<string, bigint>>;
  burned: Map<string, bigint>;
} {
  if (artifact?.kind === 'runestone' && artifact.runestone.etching)
    throw new Error('simulateRuneTransfer: etching not supported');
  if (
    (artifact?.kind === 'cenotaph' && artifact.mint) ||
    (artifact?.kind === 'runestone' && artifact.runestone.mint)
  )
    throw new Error('simulateRuneTransfer: mint not supported');
  const unallocated = new Map<string, bigint>();
  for (const [id, amount] of inputs) {
    if (amount < 0n) throw new Error('negative Rune balance');
    if (amount > 0n) unallocated.set(id, amount);
  }
  const allocated = new Map<number, Map<string, bigint>>();
  const burned = new Map<string, bigint>();
  const add = (m: Map<string, bigint>, id: string, v: bigint) =>
    m.set(id, (m.get(id) ?? 0n) + v);
  const isOpReturn = (vout: number) => outputScripts[vout]?.[0] === OP_RETURN;
  const give = (vout: number, id: string, amount: bigint) => {
    if (amount <= 0n) return;
    unallocated.set(id, unallocated.get(id)! - amount);
    const slot = allocated.get(vout) ?? new Map<string, bigint>();
    add(slot, id, amount);
    allocated.set(vout, slot);
  };
  if (artifact?.kind === 'cenotaph') {
    for (const [id, amount] of unallocated)
      if (amount > 0n) add(burned, id, amount);
    return { allocated, burned };
  }
  const nonOpReturn = outputScripts
    .map((_, vout) => vout)
    .filter((vout) => !isOpReturn(vout));
  if (artifact?.kind === 'runestone') {
    for (const edict of artifact.runestone.edicts) {
      const id = runeIdKey(edict.id);
      if (edict.id.block === 0n && edict.id.tx === 0n) continue; // no etching
      const balance = unallocated.get(id);
      if (balance === undefined) continue;
      if (edict.output > outputScripts.length)
        throw new Error('edict output out of range');
      if (edict.output === outputScripts.length) {
        if (!nonOpReturn.length) continue;
        if (edict.amount === 0n) {
          const current = unallocated.get(id)!;
          const n = BigInt(nonOpReturn.length);
          const each = current / n;
          const remainder = current % n;
          nonOpReturn.forEach((vout, i) =>
            give(vout, id, BigInt(i) < remainder ? each + 1n : each),
          );
        } else {
          for (const vout of nonOpReturn) {
            const current = unallocated.get(id)!;
            give(vout, id, edict.amount < current ? edict.amount : current);
          }
        }
      } else {
        const current = unallocated.get(id)!;
        give(
          edict.output,
          id,
          edict.amount === 0n || edict.amount > current
            ? current
            : edict.amount,
        );
      }
    }
  }
  const pointer =
    artifact?.kind === 'runestone' ? artifact.runestone.pointer : undefined;
  const target = pointer ?? nonOpReturn[0];
  for (const [id, amount] of unallocated) {
    if (amount <= 0n) continue;
    if (target === undefined) add(burned, id, amount);
    else give(target, id, amount);
  }
  for (const [vout, balances] of [...allocated]) {
    if (!isOpReturn(vout)) continue;
    for (const [id, amount] of balances) add(burned, id, amount);
    allocated.delete(vout);
  }
  return { allocated, burned };
}
