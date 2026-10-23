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
  });
};

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

export async function createVaultCanister(
  o: { canisterId?: string; host?: string; identity?: Identity } = {},
) {
  const canisterId = o.canisterId ?? DEVNET_VAULT_CANISTER;
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
  };
}
