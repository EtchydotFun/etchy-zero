import {
  PublicKey,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import {
  Reader,
  Writer,
  concat,
  decodeType,
  encodeType,
  le,
  type IdlLike,
} from './borsh.ts';
import { RUNE_POOL_IDL } from './idl.ts';

/** The rune-pool program's interface (generated from its IDL). */
export const IDL: IdlLike = RUNE_POOL_IDL as unknown as IdlLike;
export const PROGRAM_ID = new PublicKey(IDL.address);

const enc = (s: string) => new TextEncoder().encode(s);
const eq = (a: Uint8Array, b: readonly number[]) =>
  a.length >= b.length && b.every((x, i) => a[i] === x);

/**
 * One rune-pool instruction from the IDL: `args` and `accounts` by their
 * IDL names (snake_case); fixed addresses (token / system programs) are
 * filled in. `remaining`: extra accounts after the IDL's.
 */
export function instruction(
  name: string,
  args: Record<string, unknown>,
  accounts: Record<string, PublicKey | null>,
  remaining: AccountMeta[] = [],
  programId: PublicKey = PROGRAM_ID,
): TransactionInstruction {
  const def = IDL.instructions.find((x) => x.name === name);
  if (!def) throw new Error(`no instruction ${name}`);
  const w = new Writer();
  w.bytes(Uint8Array.from(def.discriminator));
  for (const a of def.args) {
    if (!(a.name in args))
      throw new Error(`${name}: argument ${a.name} missing`);
    encodeType(IDL, w, a.type, args[a.name], a.name);
  }
  const keys: AccountMeta[] = def.accounts.map((a) => {
    let key = accounts[a.name];
    if (key === undefined && a.address) key = new PublicKey(a.address);
    if (key === undefined)
      throw new Error(`${name}: account ${a.name} missing`);
    if (key === null) {
      if (!a.optional)
        throw new Error(`${name}: account ${a.name} is required`);
      return { pubkey: programId, isSigner: false, isWritable: false };
    }
    return { pubkey: key, isSigner: !!a.signer, isWritable: !!a.writable };
  });
  return new TransactionInstruction({
    programId,
    keys: [...keys, ...remaining],
    data: Buffer.from(w.done()),
  });
}

export function accountDiscriminator(name: string): Uint8Array {
  const a = IDL.accounts.find((x) => x.name === name);
  if (!a) throw new Error(`no account type ${name}`);
  return Uint8Array.from(a.discriminator);
}

/** An account's fields (IDL names), checked to be of type `name`. */
export function decodeAccount<T = Record<string, unknown>>(
  name: string,
  data: Uint8Array,
): T {
  if (!eq(data, [...accountDiscriminator(name)]))
    throw new Error(`not a ${name} account`);
  const r = new Reader(data);
  r.take(8);
  return decodeType(IDL, r, { defined: { name } }) as T;
}

export interface ProgramEvent {
  name: string;
  data: Record<string, unknown>;
}
/** An event's bytes (`Program data:` base64, discriminator first). */
export function decodeEvent(data: Uint8Array): ProgramEvent | null {
  for (const e of IDL.events) {
    if (!eq(data, e.discriminator)) continue;
    const r = new Reader(data);
    r.take(8);
    try {
      return {
        name: e.name,
        data: decodeType(IDL, r, { defined: { name: e.name } }) as Record<
          string,
          unknown
        >,
      };
    } catch {
      return null;
    }
  }
  return null;
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Every event this program emitted in a transaction's logs (in order). */
export function eventsFromLogs(
  logs: readonly string[],
  programId: PublicKey = PROGRAM_ID,
): ProgramEvent[] {
  const me = programId.toBase58();
  const stack: string[] = [];
  const out: ProgramEvent[] = [];
  for (const l of logs) {
    let m = /^Program (\w+) invoke \[\d+\]$/.exec(l);
    if (m) {
      stack.push(m[1]);
      continue;
    }
    m = /^Program (\w+) (success|failed)/.exec(l);
    if (m) {
      stack.pop();
      continue;
    }
    if (l.startsWith('Program data: ') && stack[stack.length - 1] === me) {
      try {
        const e = decodeEvent(b64(l.slice(14).trim()));
        if (e) out.push(e);
      } catch {
        /* not ours */
      }
    }
  }
  return out;
}

/** The program's error name for a custom error code (6000 + n). */
export function errorName(code: number): string | null {
  return IDL.errors?.find((e) => e.code === code)?.name ?? null;
}

const find = (seeds: Uint8Array[], programId = PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

/** Every rune-pool address (program-derived). */
export const pda = {
  config: () => find([enc('config')]),
  bitcoin: () => find([enc('bitcoin')]),
  /** A pool's address: its Rune id `block:tx`. */
  pool: (block: bigint | number, tx: number) =>
    find([enc('pool'), le(block, 8), le(tx, 4)]),
  /** A pool's WBTC (the BTC side). */
  vault: (pool: PublicKey) => find([enc('vault'), pool.toBytes()]),
  btcVault: (pool: PublicKey) => find([enc('btc_vault'), pool.toBytes()]),
  /** One owner's Runes in one pool (the owner: a wallet, a program, a Bitcoin wallet's owner address). */
  balance: (pool: PublicKey, owner: PublicKey) =>
    find([enc('balance'), pool.toBytes(), owner.toBytes()]),
  withdrawal: (pool: PublicKey, id: bigint | number) =>
    find([enc('withdrawal'), pool.toBytes(), le(id, 8)]),
  /** A Bitcoin wallet's owner address (its Taproot output key). */
  btcOwner: (taprootKey: Uint8Array) => find([enc('btc_owner'), taprootKey]),
  launch: (launchKey: Uint8Array) => find([enc('launch'), launchKey]),
  /** A Bitcoin wallet's SOL deposit address (NEAR's recipient; a plain system account). */
  btcSol: (taprootKey: Uint8Array) => find([enc('btc_sol'), taprootKey]),
  solSwap: () => find([enc('sol_swap')]),
  /** Signs for a wallet's swap inbox (its WBTC account is the inbox). */
  solSwapAuthority: (owner: PublicKey) =>
    find([enc('sol_swap'), owner.toBytes()]),
  /** A Bitcoin transaction proven for a pool (`prove_coin_spend`, once). */
  proven: (pool: PublicKey, txid: Uint8Array) =>
    find([enc('proven'), pool.toBytes(), txid]),
  coin: (pool: PublicKey, txid: Uint8Array, vout: number) =>
    find([enc('coin'), pool.toBytes(), txid, le(vout, 4)]),
};

export { concat };
