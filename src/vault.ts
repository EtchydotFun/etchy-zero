import {
  Actor,
  AnonymousIdentity,
  HttpAgent,
  type Identity,
} from '@dfinity/agent';
import { IDL } from '@dfinity/candid';
import { Principal } from '@dfinity/principal';
import type { PoolRelayerVault } from './keeper.ts';

/**
 * The pool vault canister on the Internet Computer
 * (rune-pool/vault/pool-vault): every pool's Bitcoin vault key (threshold
 * Schnorr; no person or machine has it, Etchy included). It signs only what
 * the rune-pool program's finalized state asks for.
 *
 * ANYONE may call `runOpenVault`, `runStartBatch`, `runPayBatch` and
 * `runWithdrawalFee` (an anonymous identity is fine): the canister then picks the recent
 * blockhash and the Bitcoin fee rate itself and sends what it signs, so no
 * caller can withhold or bend anything. Anyone's calls are limited per pool
 * per hour (they cost the canister cycles; anyone may top them up).
 *
 * Needs `@dfinity/agent`, `@dfinity/candid`, `@dfinity/principal`
 * (import `@etchydotfun/rune-pool/vault`).
 */
export const ICP_HOST = 'https://icp-api.io';
/** The mainnet canister (ICP production key `key_1`, Solana and Bitcoin mainnet). */
export const MAINNET_VAULT_CANISTER = 'j22zd-eyaaa-aaaao-qqkza-cai';
/** The devnet test canister (ICP test key, Solana devnet). */
export const DEVNET_VAULT_CANISTER = 'rdl3p-uqaaa-aaaaa-qhvpq-cai';

const idl: IDL.InterfaceFactory = ({ IDL: I }) => {
  const R = (ok: IDL.Type) => I.Variant({ Ok: ok, Err: I.Text });
  const AddressInfo = I.Record({
    internal_key: I.Text,
    script_pubkey: I.Text,
    address: I.Text,
  });
  const SolanaSent = I.Record({
    signature: I.Text,
    detail: I.Text,
    blockhash: I.Text,
    note: I.Text,
  });
  const BitcoinTx = I.Record({
    pool: I.Text,
    batch: I.Nat64,
    txid: I.Text,
    raw: I.Text,
    fee_sats: I.Nat64,
    fee_rate: I.Nat64,
    version: I.Nat32,
    ids: I.Vec(I.Nat64),
  });
  const PublicLimits = I.Record({
    per_pool_per_hour: I.Nat32,
    per_hour: I.Nat32,
  });
  const PictureArg = I.Record({
    index: I.Nat16,
    content_type: I.Text,
    content: I.Vec(I.Nat8),
    proof: I.Vec(I.Vec(I.Nat8)),
  });
  const RevealTx = I.Record({
    pool: I.Text,
    batch: I.Nat64,
    txid: I.Text,
    raw: I.Text,
    pictures: I.Vec(I.Nat16),
    takes: I.Vec(I.Nat64),
    fee_sats: I.Nat64,
    state: I.Text,
  });
  const OrdState = I.Record({
    held: I.Vec(I.Nat64),
    reveals: I.Vec(RevealTx),
    logo: I.Opt(I.Text),
    held_bytes: I.Nat64,
  });
  const ShelfTx = I.Record({
    pool: I.Text,
    item: I.Nat16,
    txid: I.Text,
    raw: I.Text,
    fee_sats: I.Nat64,
    state: I.Text,
  });
  const ShelfState = I.Record({
    geneses: I.Vec(I.Record({ reveal: I.Text, items: I.Vec(I.Nat16) })),
    sends: I.Vec(ShelfTx),
  });
  const Status = I.Record({
    version: I.Text,
    paused: I.Bool,
    admin: I.Principal,
    callers: I.Vec(I.Principal),
    key_name: I.Text,
    program: I.Text,
    cluster: I.Variant({ Mainnet: I.Null, Devnet: I.Null }),
    btc_network: I.Variant({
      Mainnet: I.Null,
      Testnet: I.Null,
      Regtest: I.Null,
    }),
    policy: I.Record({
      postage: I.Nat64,
      max_fee_rate: I.Nat64,
      max_fee: I.Nat64,
      max_payouts: I.Nat32,
      max_runestone: I.Nat32,
    }),
    solana_key: I.Opt(I.Text),
    batches_signed: I.Nat64,
    signatures: I.Nat64,
    public_limits: PublicLimits,
    known_pools: I.Nat64,
  });
  return I.Service({
    solana_key: I.Func([], [R(I.Text)], []),
    vault_address: I.Func([I.Text], [R(AddressInfo)], []),
    launch_address: I.Func([I.Text], [R(AddressInfo)], []),
    fee_address: I.Func([], [R(AddressInfo)], []),
    run_open_vault: I.Func([I.Text], [R(SolanaSent)], []),
    run_start_batch: I.Func([I.Text], [R(SolanaSent)], []),
    run_pay_batch: I.Func([I.Text], [R(BitcoinTx)], []),
    run_withdrawal_fee: I.Func([], [R(SolanaSent)], []),
    status: I.Func([], [Status], ['query']),
    // M123 Ordinal Runes.
    launch_ord_address: I.Func([I.Text], [R(AddressInfo)], []),
    ord_address: I.Func([I.Text], [R(AddressInfo)], []),
    ord_pictures: I.Func([I.Text, I.Nat64, I.Vec(PictureArg)], [R(I.Text)], []),
    run_reveal: I.Func([I.Text], [R(RevealTx)], []),
    run_ord_fee: I.Func([], [R(SolanaSent)], []),
    ord_state: I.Func([I.Text], [OrdState], ['query']),
    // M129 the Ordinals shelf.
    shelf_address: I.Func([I.Text], [R(AddressInfo)], []),
    run_set_shelf: I.Func([I.Text], [R(SolanaSent)], []),
    run_ord_genesis: I.Func([I.Text], [R(SolanaSent)], []),
    run_shelf_send: I.Func([I.Text, I.Nat16], [R(ShelfTx)], []),
    shelf_state: I.Func([I.Text], [ShelfState], ['query']),
  });
};

/** M129: an Ordinal leaving the shelf, sent by the canister from its own coin. */
export interface VaultShelfSend {
  pool: string;
  item: number;
  /** Display order. */
  txid: string;
  raw: string;
  fee_sats: bigint;
  /** sent, confirmed (its coin is spent). */
  state: string;
}
export interface VaultShelfState {
  geneses: { reveal: string; items: number[] }[];
  sends: VaultShelfSend[];
}

/** M123: one drawn picture handed to the canister, with its proof against the collection's root. */
export interface VaultPicture {
  index: number;
  content_type: string;
  content: Uint8Array | number[];
  proof: (Uint8Array | number[])[];
}
/** M123: a batch's reveal (its pictures inscribed to their holders). */
export interface VaultReveal {
  pool: string;
  batch: bigint;
  /** Display order; empty until signed. */
  txid: string;
  raw: string;
  /** Collection indexes, in output order (output J + 1). */
  pictures: number[];
  takes: bigint[];
  fee_sats: bigint;
  /** waiting (for the batch's block), sent, confirmed. */
  state: string;
}
export interface VaultOrdState {
  held: bigint[];
  reveals: VaultReveal[];
  logo: [] | [string];
  held_bytes: bigint;
}

export interface VaultAddress {
  internal_key: string;
  script_pubkey: string;
  address: string;
}
/** A Solana transaction the canister signed and sent itself. */
export interface VaultSent {
  signature: string;
  detail: string;
  blockhash: string;
  note: string;
}
export interface VaultPayment {
  pool: string;
  batch: bigint;
  /** Display order. */
  txid: string;
  raw: string;
  fee_sats: bigint;
  fee_rate: bigint;
  version: number;
  ids: bigint[];
}
export interface VaultStatus {
  version: string;
  paused: boolean;
  program: string;
  solana_key: [] | [string];
  batches_signed: bigint;
  signatures: bigint;
  public_limits: { per_pool_per_hour: number; per_hour: number };
  known_pools: bigint;
}

/** The canister's own refusal (its `Err` text, e.g. NOTHING_TO_START). */
export class VaultError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** The vault canister's client: mainnet's unless `canisterId` says otherwise (devnet: `DEVNET_VAULT_CANISTER`). */
export async function createVaultCanister(
  o: { canisterId?: string; host?: string; identity?: Identity } = {},
) {
  const canisterId = o.canisterId ?? MAINNET_VAULT_CANISTER;
  const agent = await HttpAgent.create({
    host: o.host ?? ICP_HOST,
    identity: o.identity ?? new AnonymousIdentity(),
  });
  const actor = Actor.createActor(idl, {
    agent,
    canisterId: Principal.fromText(canisterId),
  }) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const ok = <T>(r: unknown): T => {
    const v = r as { Ok: T } | { Err: string };
    if ('Err' in v) throw new VaultError(v.Err);
    return v.Ok;
  };
  return {
    canisterId,
    solanaKey: async () => ok<string>(await actor.solana_key()),
    vaultAddress: async (pool: string) =>
      ok<VaultAddress>(await actor.vault_address(pool)),
    /** Etch a new Rune's whole supply here, then make its launch pool with this key. */
    launchAddress: async (launchKeyHex: string) =>
      ok<VaultAddress>(await actor.launch_address(launchKeyHex)),
    /** Pays the miners of vault transactions: anyone may send it BTC. */
    feeAddress: async () => ok<VaultAddress>(await actor.fee_address()),
    runOpenVault: async (pool: string) =>
      ok<VaultSent>(await actor.run_open_vault(pool)),
    runStartBatch: async (pool: string) =>
      ok<VaultSent>(await actor.run_start_batch(pool)),
    runPayBatch: async (pool: string) =>
      ok<VaultPayment>(await actor.run_pay_batch(pool)),
    /**
     * The program's withdrawal fee set to what a withdrawal costs at the
     * Bitcoin fee rate now (up once 10% short, down once 25% high, at most
     * every 30 minutes); `FEE_UNCHANGED` / `FEE_SET_RECENTLY` otherwise.
     */
    runWithdrawalFee: async () =>
      ok<VaultSent>(await actor.run_withdrawal_fee()),
    status: async () => (await actor.status()) as VaultStatus,
    // ---- M123 Ordinal Runes
    /** Etch a collection's logo here (output 0), with its supply to `launchAddress`. */
    launchOrdAddress: async (launchKeyHex: string) =>
      ok<VaultAddress>(await actor.launch_ord_address(launchKeyHex)),
    ordAddress: async (pool: string) =>
      ok<VaultAddress>(await actor.ord_address(pool)),
    /** A drawn take-out's pictures (checked against the collection's root): its batch may then go. */
    ordPictures: async (pool: string, take: bigint, pictures: VaultPicture[]) =>
      ok<string>(
        await actor.ord_pictures(
          pool,
          take,
          pictures.map((p) => ({
            index: p.index,
            content_type: p.content_type,
            content: Uint8Array.from(p.content),
            proof: p.proof.map((x) => Uint8Array.from(x)),
          })),
        ),
      ),
    /** The pool's oldest batch with pictures, once in a block: its reveal (the same one if asked again). */
    runReveal: async (pool: string) =>
      ok<VaultReveal>(await actor.run_reveal(pool)),
    /** The program's picture fee from the Bitcoin fee rate now (`ORD_FEE_UNCHANGED` / `ORD_FEE_SET_RECENTLY` otherwise). */
    runOrdFee: async () => ok<VaultSent>(await actor.run_ord_fee()),
    ordState: async (pool: string) =>
      (await actor.ord_state(pool)) as VaultOrdState,
    // ---- M129 the Ordinals shelf
    /** Where Ordinals are sold back to the pool (a key of this canister). */
    shelfAddress: async (pool: string) =>
      ok<VaultAddress>(await actor.shelf_address(pool)),
    /** The program's `set_shelf` (once; `SHELF_SET` after). */
    runSetShelf: async (pool: string) =>
      ok<VaultSent>(await actor.run_set_shelf(pool)),
    /** Where the canister's reveals put the pool's Ordinals, told to the program. */
    runOrdGenesis: async (pool: string) =>
      ok<VaultSent>(await actor.run_ord_genesis(pool)),
    /** An Ordinal the program says leaves the shelf, sent from its own coin. */
    runShelfSend: async (pool: string, item: number) =>
      ok<VaultShelfSend>(await actor.run_shelf_send(pool, item)),
    shelfState: async (pool: string) =>
      (await actor.shelf_state(pool)) as VaultShelfState,
  };
}
export type VaultCanister = Awaited<ReturnType<typeof createVaultCanister>>;

/** The canister as the keeper's vault (anyone's calls). */
export function keeperVault(v: VaultCanister): PoolRelayerVault {
  return {
    vaultScript: async (pool) => (await v.vaultAddress(pool)).script_pubkey,
    openVault: async (pool) => (await v.runOpenVault(pool)).signature,
    startBatch: async (pool) => (await v.runStartBatch(pool)).signature,
    async payBatch(pool) {
      const b = await v.runPayBatch(pool);
      return { txid: b.txid, feeRate: Number(b.fee_rate), version: b.version };
    },
    withdrawalFee: async () => (await v.runWithdrawalFee()).signature,
    // M123 Ordinal Runes.
    async ordState(pool) {
      const s = await v.ordState(pool);
      return {
        held: s.held,
        revealing: s.reveals.flatMap((r) => r.takes),
        reveals: s.reveals.length,
      };
    },
    ordPictures: (pool, id, pictures) =>
      v.ordPictures(
        pool,
        id,
        pictures.map((p) => ({
          index: p.index,
          content_type: p.contentType,
          content: p.content,
          proof: p.proof,
        })),
      ),
    async reveal(pool) {
      const r = await v.runReveal(pool);
      return { txid: r.txid, state: r.state, batch: r.batch };
    },
    ordFee: async () => (await v.runOrdFee()).signature,
    // M129 the Ordinals shelf.
    setShelf: async (pool) => (await v.runSetShelf(pool)).signature,
    ordGenesis: async (pool) => (await v.runOrdGenesis(pool)).signature,
    async shelfSend(pool, item) {
      const s = await v.runShelfSend(pool, item);
      return { txid: s.txid, state: s.state };
    },
  };
}
