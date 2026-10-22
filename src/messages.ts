import { PublicKey } from '@solana/web3.js';
import { concat } from './borsh.ts';

/**
 * Everything a wallet signs or a Bitcoin transaction carries, byte for byte
 * as the program checks it: Rune names, the Bitcoin wallet's signed
 * messages (BIP-322), the Runes deposit memo, and Bitcoin addresses.
 *
 * Every signed message starts with "Etchy Rune Pools (mainnet):" or
 * "(devnet):" (`poolNetwork`), so one signed for devnet never works on
 * mainnet.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const U128_MAX = (1n << 128n) - 1n;

/** A Rune's name (base-26). */
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
/** With its spacers (`ETCHY•FUN`). */
export function formatSpacedRune(rune: bigint, spacers: number): string {
  const name = formatRune(rune);
  let out = '';
  for (let i = 0; i < name.length; i++) {
    out += name[i];
    if (i < name.length - 1 && (spacers & (1 << i)) !== 0) out += '\u2022';
  }
  return out;
}
/** `amount` raw units with `divisibility` decimals ("1234.500000"). */
export function formatUnits(amount: bigint, divisibility: number): string {
  if (divisibility === 0) return amount.toString();
  const p = 10n ** BigInt(divisibility);
  return `${amount / p}.${(amount % p).toString().padStart(divisibility, '0')}`;
}

/** The name fields of a pool (what the signed messages show). */
export interface RuneLabel {
  runeName: bigint;
  spacers: number;
  runeBlock: bigint;
  runeTx: number;
  divisibility: number;
}
const label = (p: RuneLabel) =>
  `${formatSpacedRune(p.runeName, p.spacers)} (Rune ${p.runeBlock}:${p.runeTx})`;

/** Which program the messages are for (its quote mint decides). */
export type PoolNetwork = 'mainnet' | 'devnet';
/** Mainnet WBTC (Portal): the quote mint of the mainnet program. */
export const MAINNET_WBTC = new PublicKey(
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
);
/** `Config::network`: "mainnet" with mainnet WBTC as the quote mint, else "devnet". */
export const poolNetwork = (quoteMint: PublicKey): PoolNetwork =>
  quoteMint.equals(MAINNET_WBTC) ? 'mainnet' : 'devnet';
const head = (n: PoolNetwork) => `Etchy Rune Pools (${n}):`;

/**
 * The order a Bitcoin wallet signs for ONE buy (`amount` sats of WBTC from
 * its Etchy balance, at least `minOut` Rune units) or sale (`amount` Rune
 * units, at least `minOut` sats). Order numbers are used once, in order.
 */
export function tradeMessage(
  network: PoolNetwork,
  pool: RuneLabel,
  isBuy: boolean,
  amount: bigint,
  minOut: bigint,
  nonce: bigint,
  expiry: bigint,
): string {
  const name = formatSpacedRune(pool.runeName, pool.spacers);
  const h = head(network);
  const what = isBuy
    ? `${h} buy ${label(pool)} with ${formatUnits(amount, 8)} BTC of my Etchy balance, for at least ${formatUnits(minOut, pool.divisibility)} ${name}.`
    : `${h} sell ${formatUnits(amount, pool.divisibility)} ${label(pool)} of my Etchy balance for at least ${formatUnits(minOut, 8)} BTC.`;
  return `${what}\nOrder ${nonce}, valid until ${expiry} (unix time).`;
}

/** Lets a Solana key (e.g. a browser session key) send or withdraw up to `amount`; 0 revokes. */
export function approveMessage(
  network: PoolNetwork,
  pool: RuneLabel,
  delegate: string,
  amount: bigint,
  nonce: bigint,
  expiry: bigint,
): string {
  const name = formatSpacedRune(pool.runeName, pool.spacers);
  const rune = `(Rune ${pool.runeBlock}:${pool.runeTx})`;
  const h = head(network);
  const what =
    amount === 0n
      ? `${h} stop ${delegate} from using my ${name} ${rune}.`
      : `${h} let ${delegate} sell, send or withdraw up to ${formatUnits(amount, pool.divisibility)} ${name} ${rune} of my Etchy balance.`;
  return `${what}\nApproval ${nonce}, valid until ${expiry} (unix time).`;
}

/** Moves WBTC out of a Bitcoin wallet's Etchy balance to a Solana wallet. */
export function sendWbtcMessage(
  network: PoolNetwork,
  amount: bigint,
  toWallet: string,
  nonce: bigint,
  expiry: bigint,
): string {
  return `${head(network)} send ${amount} sats of WBTC from my Etchy balance to the Solana wallet ${toWallet}.\nApproval ${nonce}, valid until ${expiry} (unix time).`;
}

/**
 * The 64-byte Schnorr signature inside a wallet's BIP-322 "simple"
 * signature of a Taproot address (base64 witness, as Xverse, UniSat and
 * Leather return it). This is what the program checks; null if it is not
 * a one-item key-path witness.
 */
export function bip322Signature(signature: string): Uint8Array | null {
  const body = signature.trim().replace(/^smp/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length > 400) return null;
  const raw = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  // One witness item: count 1, length 64 or 65 (a sighash byte), the signature.
  if (raw.length < 2 || raw[0] !== 1 || raw.length !== 2 + raw[1]) return null;
  if (raw[1] !== 64 && raw[1] !== 65) return null;
  return raw.slice(2, 66);
}

/** A Bitcoin address a NEAR withdrawal may name (`rune_pool::btc_address_ok`). */
export const nearAddressOk = (a: string) => /^[A-Za-z0-9]{14,90}$/.test(a);

/**
 * Withdraws `amount` sats of WBTC from a Bitcoin wallet's Etchy balance to
 * `btcAddress` through NEAR: anyone may take the WBTC only by sending at
 * least `minLamports` of SOL to NEAR's deposit address `deposit` (the
 * quote that pays `btcAddress`) in the same transaction.
 */
export function nearWithdrawMessage(
  network: PoolNetwork,
  amount: bigint,
  minLamports: bigint,
  btcAddress: string,
  deposit: string,
  nonce: bigint,
  expiry: bigint,
): string {
  return `${head(network)} withdraw ${formatUnits(amount, 8)} BTC of my Etchy balance to ${btcAddress} through NEAR: sell it for at least ${formatUnits(minLamports, 9)} SOL sent to NEAR's deposit address ${deposit}.\nOrder ${nonce}, valid until ${expiry} (unix time).`;
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const d = await globalThis.crypto.subtle.digest(
    'SHA-256',
    concat(...parts) as Uint8Array<ArrayBuffer>,
  );
  return new Uint8Array(d);
}
const enc = (s: string) => new TextEncoder().encode(s);

const memo = (tag: string, body: Uint8Array) =>
  concat(Uint8Array.from([0x6a, 0x24]), enc(tag), body);

/** The OP_RETURN output of a Runes deposit into a pool's vault: credited to `owner`. */
export const depositMemo = (owner: PublicKey) => memo('ETCH', owner.toBytes());

// ---------------------------------------------------------------- bech32m (bc1p)
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = (((chk & 0x01ffffff) << 5) ^ v) >>> 0;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk = (chk ^ GEN[i]) >>> 0;
  }
  return chk;
}
const hrpExpand = (hrp: string) => [
  ...[...hrp].map((c) => c.charCodeAt(0) >> 5),
  0,
  ...[...hrp].map((c) => c.charCodeAt(0) & 31),
];
const BECH32M = 0x2bc830a3;
function convert(
  data: number[],
  from: number,
  to: number,
  pad: boolean,
): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & max);
  else if (!pad && (bits >= from || ((acc << (to - bits)) & max) !== 0))
    return null;
  return out;
}

/** A mainnet Taproot address (bc1p...) -> its 32-byte output key (what owns a Bitcoin wallet's balance). */
export function taprootKey(address: string): Uint8Array {
  const a = address.trim().toLowerCase();
  const sep = a.lastIndexOf('1');
  const hrp = a.slice(0, sep);
  if (hrp !== 'bc') throw new Error('not a mainnet address (bc1p...)');
  const words = [...a.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  if (words.some((w) => w < 0) || words.length < 7)
    throw new Error('not a bech32m address');
  const chk = polymod([...hrpExpand(hrp), ...words]);
  // bech32 (constant 1): a SegWit v0 address (bc1q), not Taproot.
  if (chk === 1) throw new Error('not a Taproot address (bc1p...)');
  if (chk !== BECH32M) throw new Error('bad address checksum');
  const data = words.slice(0, -6);
  if (data[0] !== 1) throw new Error('not a Taproot address (bc1p...)');
  const prog = convert(data.slice(1), 5, 8, false);
  if (!prog || prog.length !== 32)
    throw new Error('not a Taproot address (bc1p...)');
  return Uint8Array.from(prog);
}
/** A 32-byte output key -> its bc1p address. */
export function taprootAddress(key: Uint8Array): string {
  if (key.length !== 32) throw new Error('a Taproot key is 32 bytes');
  const data = [1, ...convert([...key], 8, 5, true)!];
  const mod =
    polymod([...hrpExpand('bc'), ...data, 0, 0, 0, 0, 0, 0]) ^ BECH32M;
  const chk = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `bc1${[...data, ...chk].map((w) => CHARSET[w]).join('')}`;
}
/** A P2TR output script (51 20 <key>) -> its bc1p address; null for other scripts. */
export function p2trAddress(script: Uint8Array): string | null {
  if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20)
    return null;
  return taprootAddress(script.subarray(2));
}

// ---------------------------------------------------------------- any address
export type BitcoinNetwork = 'mainnet' | 'regtest';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const VERSIONS = {
  mainnet: { hrp: 'bc', p2pkh: 0x00, p2sh: 0x05 },
  regtest: { hrp: 'bcrt', p2pkh: 0x6f, p2sh: 0xc4 },
};
function segwitAddress(hrp: string, version: number, program: Uint8Array) {
  const data = [version, ...convert([...program], 8, 5, true)!];
  const mod =
    polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^
    (version === 0 ? 1 : BECH32M);
  const chk = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...chk].map((w) => CHARSET[w]).join('')}`;
}
async function checksum4(data: Uint8Array) {
  return (await sha256(await sha256(data))).subarray(0, 4);
}
async function base58check(version: number, hash: Uint8Array) {
  const data = concat(Uint8Array.from([version]), hash);
  const bytes = concat(data, await checksum4(data));
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
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

/**
 * The address of a standard output script (P2PKH, P2SH, P2WPKH, P2WSH,
 * P2TR); null for other scripts.
 */
export async function scriptAddress(
  script: Uint8Array,
  network: BitcoinNetwork = 'mainnet',
): Promise<string | null> {
  const v = VERSIONS[network];
  const s = script;
  if (
    s.length === 25 &&
    s[0] === 0x76 &&
    s[1] === 0xa9 &&
    s[2] === 0x14 &&
    s[23] === 0x88 &&
    s[24] === 0xac
  )
    return base58check(v.p2pkh, s.subarray(3, 23));
  if (s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87)
    return base58check(v.p2sh, s.subarray(2, 22));
  if (s.length === 22 && s[0] === 0x00 && s[1] === 0x14)
    return segwitAddress(v.hrp, 0, s.subarray(2));
  if (s.length === 34 && s[0] === 0x00 && s[1] === 0x20)
    return segwitAddress(v.hrp, 0, s.subarray(2));
  if (s.length === 34 && s[0] === 0x51 && s[1] === 0x20)
    return segwitAddress(v.hrp, 1, s.subarray(2));
  return null;
}

/** A Bitcoin address (any standard kind) -> its output script. Throws if it is not valid. */
export async function addressScript(
  address: string,
  network: BitcoinNetwork = 'mainnet',
): Promise<Uint8Array> {
  const v = VERSIONS[network];
  const a = address.trim();
  const low = a.toLowerCase();
  if (low.startsWith(`${v.hrp}1`)) {
    if (a !== low && a !== a.toUpperCase())
      throw new Error('mixed-case address');
    const words = [...low.slice(v.hrp.length + 1)].map((c) =>
      CHARSET.indexOf(c),
    );
    if (words.some((w) => w < 0) || words.length < 7)
      throw new Error('not a valid address');
    const chk = polymod([...hrpExpand(v.hrp), ...words]);
    const version = words[0];
    if (chk !== (version === 0 ? 1 : BECH32M))
      throw new Error('bad address checksum');
    const prog = convert(words.slice(1, -6), 5, 8, false);
    if (!prog) throw new Error('not a valid address');
    if (version === 0 && (prog.length === 20 || prog.length === 32))
      return Uint8Array.from([0x00, prog.length, ...prog]);
    if (version === 1 && prog.length === 32)
      return Uint8Array.from([0x51, 0x20, ...prog]);
    throw new Error('unsupported address type');
  }
  let n = 0n;
  for (const c of a) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('not a valid address');
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of a) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  if (bytes.length !== 25) throw new Error('not a valid address');
  const raw = Uint8Array.from(bytes);
  const sum = await checksum4(raw.subarray(0, 21));
  if (sum.some((b, i) => b !== raw[21 + i]))
    throw new Error('bad address checksum');
  const hash = raw.subarray(1, 21);
  if (raw[0] === v.p2pkh)
    return Uint8Array.from([0x76, 0xa9, 0x14, ...hash, 0x88, 0xac]);
  if (raw[0] === v.p2sh) return Uint8Array.from([0xa9, 0x14, ...hash, 0x87]);
  throw new Error('not an address of this network');
}
