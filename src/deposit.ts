import * as btc from '@scure/btc-signer';
import type { Connection, PublicKey } from '@solana/web3.js';
import { fromHex, hex } from './borsh.ts';
import {
  displayTxid,
  esplora,
  internalTxid,
  MEMPOOL_API,
  sha256d,
} from './bitcoin.ts';
import { depositMemo, taprootKey } from './messages.ts';
import { decodeAccount, pda } from './program.ts';

/**
 * Runes back into a pool, straight from the user's Bitcoin wallet (Xverse,
 * UniSat, Leather, any wallet that signs a PSBT). ONE transaction:
 *
 *   in      the wallet's coins of the pool's Rune (only coins the pool
 *           knows: their Runes are proven; see `depositableCoins`)
 *   in      plain BTC for the miner fee
 *   out 0   the pool's vault address (546 sats): all those Runes (no
 *           Runestone, so ord gives every Rune to the first output)
 *   out 1   the memo `OP_RETURN "ETCH" <owner>`: whose pool balance gets them
 *   out 2   BTC change
 *
 * That is all the user does. After the pool's confirmations any keeper
 * (Etchy's, another site's, the user's own) proves it on Solana and the Runes
 * are in the owner's balance, ready to sell. No Etchy server or relayer is
 * needed for it: the program checks the Bitcoin proof itself.
 *
 * Needs `@scure/btc-signer` (import `@etchydotfun/rune-pool/deposit`).
 */

/** A wallet address and the public key that signs for it (hex: 33-byte, or x-only 32-byte for Taproot). */
export interface WalletKey {
  address: string;
  publicKey: string;
}
/** A Bitcoin output (display txid). */
export interface BitcoinCoin {
  txid: string;
  vout: number;
  sats: bigint;
}
/** A coin of the pool's Rune that the pool knows, with its proven Runes. */
export interface PoolCoin extends BitcoinCoin {
  runes: bigint;
}
export interface DepositTx {
  /** For the wallet to sign (`signInputs`: which inputs each address signs). */
  psbtBase64: string;
  signInputs: Record<string, number[]>;
  /** For `finishDeposit`: the id of the unsigned transaction (the signed one's id is known once signed). */
  unsignedTxid: string;
  runes: bigint;
  vaultAddress: string;
  minerFeeSats: bigint;
  changeSats: bigint;
  vsize: number;
}
type Esplora = ReturnType<typeof esplora>;

const NET = btc.NETWORK;
const DUST = 546n;
const VAULT_SATS = 546n;
const SEQUENCE = 0xfffffffd;
/** Rune coins in one deposit. */
export const MAX_DEPOSIT_COINS = 8;
/**
 * Inputs of one deposit, Rune and payment coins together: what the
 * program's `prove_coin_spend` takes (every input counts). A deposit with
 * more could never be proven: its Runes would sit at the vault, uncredited.
 */
export const MAX_DEPOSIT_INPUTS = 12;
const COIN_FREE = 0;
const POOL_ACTIVE = 1;
type Raw = Record<string, unknown>;

/** The pool-balance owner of a Bitcoin wallet (its Taproot address): what the memo names. */
export const depositOwnerOf = (ordinalsAddress: string) =>
  pda.btcOwner(taprootKey(ordinalsAddress));

const scriptOf = (address: string) => {
  try {
    return btc.OutScript.encode(btc.Address(NET).decode(address));
  } catch {
    throw new Error(`not a Bitcoin mainnet address: ${address}`);
  }
};
const typeOf = (address: string) => btc.Address(NET).decode(address).type;
/** vbytes of spending one coin at this address (signed). */
function inputVbytes(address: string): number {
  const t = typeOf(address);
  if (t === 'tr') return 41 + 66 / 4;
  if (t === 'wpkh') return 41 + 108 / 4;
  if (t === 'sh') return 64 + 108 / 4;
  throw new Error(
    `unsupported address type ${t} (Taproot, P2WPKH or P2SH-P2WPKH)`,
  );
}
const outputVbytes = (script: Uint8Array) => 8 + 1 + script.length;

/** A wallet's coin as a PSBT input (for `@scure/btc-signer`'s `addInput`). */
export interface WalletInput {
  txid: string;
  index: number;
  sequence: number;
  witnessUtxo: { script: Uint8Array; amount: bigint };
  tapInternalKey?: Uint8Array;
  nonWitnessUtxo?: Uint8Array;
  redeemScript?: Uint8Array;
}
function inputFor(
  key: WalletKey,
  c: BitcoinCoin,
  prevTx?: Uint8Array,
): WalletInput {
  const script = scriptOf(key.address);
  if (!/^([0-9a-f]{64}|[0-9a-f]{66})$/i.test(key.publicKey))
    throw new Error(`bad public key for ${key.address}`);
  const pub = fromHex(key.publicKey.toLowerCase());
  const base = {
    txid: c.txid,
    index: c.vout,
    sequence: SEQUENCE,
    witnessUtxo: { script, amount: c.sats },
  };
  const t = typeOf(key.address);
  if (t === 'tr') {
    const xOnly = pub.length === 33 ? pub.subarray(1) : pub;
    if (btc.p2tr(xOnly, undefined, NET).address !== key.address)
      throw new Error(`the public key is not ${key.address}'s`);
    return { ...base, tapInternalKey: xOnly };
  }
  if (pub.length !== 33) throw new Error(`bad public key for ${key.address}`);
  // Some wallets want the whole previous transaction for non-Taproot inputs.
  const extra = prevTx ? { nonWitnessUtxo: prevTx } : {};
  if (t === 'wpkh') {
    if (btc.p2wpkh(pub, NET).address !== key.address)
      throw new Error(`the public key is not ${key.address}'s`);
    return { ...base, ...extra };
  }
  const inner = btc.p2wpkh(pub, NET);
  if (t !== 'sh' || btc.p2sh(inner, NET).address !== key.address)
    throw new Error(`the public key is not ${key.address}'s`);
  return { ...base, ...extra, redeemScript: inner.script };
}
/** A wallet's coin as a PSBT input (Taproot, P2WPKH or P2SH-P2WPKH), checked against its key. */
export const walletInput = inputFor;
/** vbytes of spending one coin at this address (signed). */
export const walletInputVbytes = inputVbytes;

const b64 = (b: Uint8Array) => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * The deposit transaction from its parts (no network): `vaultScript` is the
 * pool's vault output script, `owner` whose balance gets the Runes.
 * `prevTxs`: raw previous transactions of non-Taproot payment coins (by
 * txid), for wallets that want them.
 */
export async function buildDeposit(p: {
  vaultScript: Uint8Array;
  owner: PublicKey;
  coins: PoolCoin[];
  runes: WalletKey;
  payment: WalletKey;
  paymentCoins: BitcoinCoin[];
  feeRate: number;
  prevTxs?: Record<string, Uint8Array>;
}): Promise<DepositTx> {
  if (!p.coins.length) throw new Error('no coins of this Rune to deposit');
  if (p.coins.length > MAX_DEPOSIT_COINS)
    throw new Error(`at most ${MAX_DEPOSIT_COINS} coins per deposit`);
  if (typeOf(p.runes.address) !== 'tr')
    throw new Error('the Runes must be at a Taproot (bc1p) address');
  if (!Number.isFinite(p.feeRate) || p.feeRate < 1 || p.feeRate > 500)
    throw new Error('fee rate: 1 to 500 sat/vB');
  const seen = new Set<string>();
  for (const c of [...p.coins, ...p.paymentCoins]) {
    const k = `${c.txid}:${c.vout}`;
    if (seen.has(k)) throw new Error(`coin ${k} twice`);
    seen.add(k);
  }
  const memo = depositMemo(p.owner);
  const change = scriptOf(p.payment.address);
  const runeIn = p.coins.reduce((s, c) => s + c.sats, 0n);
  const runes = p.coins.reduce((s, c) => s + c.runes, 0n);
  const fixed =
    10.5 +
    p.coins.length * inputVbytes(p.runes.address) +
    outputVbytes(p.vaultScript) +
    outputVbytes(memo);
  const perIn = inputVbytes(p.payment.address);
  const coins = [...p.paymentCoins].sort((a, b) =>
    a.sats > b.sats ? -1 : a.sats < b.sats ? 1 : 0,
  );
  // Fewest payment coins (largest first); change if it is worth an output.
  let plan: {
    used: number;
    fee: bigint;
    change: bigint;
    vsize: number;
  } | null = null;
  let total = runeIn;
  const room = MAX_DEPOSIT_INPUTS - p.coins.length;
  for (let used = 0; used <= Math.min(coins.length, room); used++) {
    if (used) total += coins[used - 1].sats;
    const base = fixed + used * perIn;
    const vWith = Math.ceil(base + outputVbytes(change));
    const withChange = BigInt(Math.ceil(vWith * p.feeRate));
    if (total - VAULT_SATS - withChange >= DUST) {
      plan = {
        used,
        fee: withChange,
        change: total - VAULT_SATS - withChange,
        vsize: vWith,
      };
      break;
    }
    const without = BigInt(Math.ceil(Math.ceil(base) * p.feeRate));
    if (total - VAULT_SATS >= without) {
      plan = {
        used,
        fee: total - VAULT_SATS,
        change: 0n,
        vsize: Math.ceil(base),
      };
      break;
    }
  }
  if (!plan)
    throw new Error(
      `not enough plain BTC at ${p.payment.address} for the miner fee in ${room} coin(s) (a deposit takes ${MAX_DEPOSIT_INPUTS} inputs at most)`,
    );
  const tx = new btc.Transaction({ allowUnknownOutputs: true, version: 2 });
  const signInputs: Record<string, number[]> = {};
  const signer = (address: string) => (signInputs[address] ??= []);
  for (const c of p.coins) {
    signer(p.runes.address).push(tx.inputsLength);
    tx.addInput(inputFor(p.runes, c));
  }
  for (const c of coins.slice(0, plan.used)) {
    signer(p.payment.address).push(tx.inputsLength);
    tx.addInput(inputFor(p.payment, c, p.prevTxs?.[c.txid]));
  }
  tx.addOutput({ script: p.vaultScript, amount: VAULT_SATS });
  tx.addOutput({ script: memo, amount: 0n });
  if (plan.change > 0n) tx.addOutput({ script: change, amount: plan.change });
  return {
    psbtBase64: b64(tx.toPSBT()),
    signInputs,
    unsignedTxid: displayTxid(await sha256d(tx.unsignedTx)),
    runes,
    vaultAddress: btc.Address(NET).encode(btc.OutScript.decode(p.vaultScript)),
    minerFeeSats: plan.fee,
    changeSats: plan.change,
    vsize: plan.vsize,
  };
}

/** The pool's vault output script; refuses pools that cannot take deposits now. */
export async function depositVault(connection: Connection, pool: PublicKey) {
  const [pa, va] = await connection.getMultipleAccountsInfo(
    [pool, pda.btcVault(pool)],
    'confirmed',
  );
  if (!pa) throw new Error('no such pool');
  const p = decodeAccount<Raw>('Pool', pa.data);
  if (p.status !== POOL_ACTIVE) throw new Error('this pool is not open yet');
  if (!va) throw new Error('this pool has no Bitcoin vault');
  const v = decodeAccount<Raw>('BtcVault', va.data);
  if (v.alarm) throw new Error('this pool is stopped (vault alarm)');
  return {
    script: (v.script as Uint8Array).slice(0, v.script_len as number),
    rune: { block: p.rune_block as bigint, tx: BigInt(p.rune_tx as number) },
  };
}

/**
 * The coins at `address` that hold the pool's Rune and that the pool knows
 * (their Runes are proven on Solana): only these can be deposited. A coin
 * the pool does not know yet (its last move not proven) shows up once a
 * keeper has proven it.
 */
export async function depositableCoins(o: {
  connection: Connection;
  pool: PublicKey;
  address: string;
  bitcoin?: Esplora;
}): Promise<PoolCoin[]> {
  const b = o.bitcoin ?? esplora();
  const utxos =
    ((await b.get(`/address/${o.address}/utxo`)) as
      { txid: string; vout: number; value: number }[] | null) ?? [];
  const out: PoolCoin[] = [];
  for (let i = 0; i < utxos.length; i += 100) {
    const part = utxos.slice(i, i + 100);
    const infos = await o.connection.getMultipleAccountsInfo(
      part.map((u) => pda.coin(o.pool, internalTxid(u.txid), u.vout)),
      'confirmed',
    );
    infos.forEach((a, k) => {
      if (!a) return;
      const c = decodeAccount<Raw>('KnownCoin', a.data);
      if (c.kind !== COIN_FREE) return;
      out.push({
        txid: part[k].txid,
        vout: part[k].vout,
        sats: BigInt(part[k].value),
        runes: c.runes as bigint,
      });
    });
  }
  return out;
}

/**
 * Everything for one wallet deposit: the pool's vault, the coins (checked
 * against the pool's records again), the previous transactions some wallets
 * want. `paymentCoins` must be plain BTC (no Runes, no inscriptions): check
 * them with your indexer.
 */
export async function depositTransaction(o: {
  connection: Connection;
  pool: PublicKey;
  owner: PublicKey;
  coins: PoolCoin[];
  runes: WalletKey;
  payment: WalletKey;
  paymentCoins: BitcoinCoin[];
  feeRate: number;
  bitcoin?: Esplora;
}): Promise<DepositTx> {
  const b = o.bitcoin ?? esplora();
  const vault = await depositVault(o.connection, o.pool);
  const known = await depositableCoins({
    connection: o.connection,
    pool: o.pool,
    address: o.runes.address,
    bitcoin: b,
  });
  for (const c of o.coins) {
    const k = known.find((x) => x.txid === c.txid && x.vout === c.vout);
    if (!k || k.runes !== c.runes || k.sats !== c.sats)
      throw new Error(
        `coin ${c.txid}:${c.vout} is not a known, unspent coin of this pool at ${o.runes.address}`,
      );
  }
  const prevTxs: Record<string, Uint8Array> = {};
  if (typeOf(o.payment.address) !== 'tr')
    for (const c of o.paymentCoins)
      prevTxs[c.txid] ??= fromHex(
        ((await b.get(`/tx/${c.txid}/hex`, true)) as string).trim(),
      );
  return buildDeposit({ ...o, vaultScript: vault.script, prevTxs });
}

/** The wallet's signed PSBT -> the raw transaction (refused unless it is the one that was built). */
export async function finishDeposit(
  signedPsbtBase64: string,
  unsignedTxid: string,
): Promise<{ txid: string; rawHex: string }> {
  const tx = btc.Transaction.fromPSBT(unb64(signedPsbtBase64), {
    allowUnknownOutputs: true,
  });
  if (displayTxid(await sha256d(tx.unsignedTx)) !== unsignedTxid)
    throw new Error('the wallet signed a different transaction');
  for (let i = 0; i < tx.inputsLength; i++) {
    const x = tx.getInput(i);
    if (!(x.finalScriptSig?.length || x.finalScriptWitness?.length))
      tx.finalizeIdx(i);
  }
  return { txid: tx.id, rawHex: hex(tx.extract()) };
}

/** Sends it to Bitcoin (any Esplora server). */
export async function sendDeposit(
  rawHex: string,
  base = MEMPOOL_API,
): Promise<string> {
  const r = await fetch(`${base}/tx`, {
    method: 'POST',
    body: rawHex,
    signal: AbortSignal.timeout(30_000),
  });
  const t = (await r.text()).trim();
  if (!r.ok) throw new Error(`Bitcoin refused it: ${t.slice(0, 200)}`);
  return t;
}

/**
 * Where a deposit is: `waiting` (not proven yet: confirmations, then any
 * keeper), `proven` (its Runes recorded, not credited yet), `credited` (in
 * the owner's balance), `swept` (merged into the vault coin since; it was
 * credited if the memo named an owner).
 */
export async function depositStatus(o: {
  connection: Connection;
  pool: PublicKey;
  txid: string;
}): Promise<{
  state: 'waiting' | 'proven' | 'credited' | 'swept';
  runes?: bigint;
  owner?: string;
}> {
  const id = internalTxid(o.txid);
  const [proven, coin] = await o.connection.getMultipleAccountsInfo(
    [pda.proven(o.pool, id), pda.coin(o.pool, id, 0)],
    'confirmed',
  );
  if (!proven) return { state: 'waiting' };
  if (!coin) return { state: 'swept' };
  const c = decodeAccount<Raw>('KnownCoin', coin.data);
  return {
    state: c.credited ? 'credited' : 'proven',
    runes: c.runes as bigint,
    owner: (c.owner as PublicKey).toBase58(),
  };
}
