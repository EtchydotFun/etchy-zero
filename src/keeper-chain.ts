import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountMeta,
  type AddressLookupTableAccount,
  type Connection,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import { esplora } from './bitcoin.ts';
import { base58, concat, le } from './borsh.ts';
import {
  createPoolRelayer,
  memoryPoolRelayerStore,
  type PoolRelayerBitcoin,
  type PoolRelayerChain,
  type PoolRelayerStore,
  type PoolRelayerVault,
  type RelayerCoin,
  type RelayerNamedProof,
  type RelayerPool,
  type RelayerProof,
} from './keeper.ts';
import {
  accountDiscriminator,
  decodeAccount,
  instruction,
  pda,
  PROGRAM_ID,
} from './program.ts';

/**
 * The keeper's Solana side for anyone: a Solana key with a little SOL (it
 * pays the fees, and rent that comes back when records close) and an RPC.
 * Every instruction it sends is one anybody may send; the program checks
 * every proof.
 *
 *   const keeper = createKeeper({ connection, payer, vault: keeperVault(await createVaultCanister()) });
 *   setInterval(() => keeper.tick(), 60_000);
 */
export const BTC_RELAY_PROGRAM = new PublicKey(
  '9enwiwQwfPH5FSjcSo1fDViJwM8kQn5LpsrEq3uKXrbY',
);
/**
 * Devnet lookup table of the accounts every Bitcoin proof names (so big
 * proofs fit one transaction). Anyone may use it, or make their own.
 */
export const DEVNET_LOOKUP_TABLE = new PublicKey(
  '9drGTuME311J1BoYDVeNc5QSK4RpuH4kp8T8Uv1tHNgV',
);
/** btc-relay `submit_headers` (Anchor discriminator). */
const SUBMIT_HEADERS = [151, 116, 247, 16, 199, 207, 48, 40];
const WD_IN_BATCH = 1;
const WD_DELIVERED = 2;
const COIN_DEPOSIT = 1;
type Raw = Record<string, unknown>;

/** Where a named Rune's proof buffer key is kept while it is written (resume after a restart). */
export interface ProofBufferStore {
  load(pool: string): Promise<Keypair | null>;
  save(pool: string, key: Keypair): Promise<void>;
  clear(pool: string): Promise<void>;
}
export function memoryProofBufferStore(): ProofBufferStore {
  const m = new Map<string, Keypair>();
  return {
    load: async (p) => m.get(p) ?? null,
    save: async (p, k) => void m.set(p, k),
    clear: async (p) => void m.delete(p),
  };
}

export function solanaKeeperChain(o: {
  connection: Connection;
  payer: Keypair;
  /** Lets big Bitcoin proofs fit a transaction (v0 lookup table of the fixed accounts). */
  lookupTable?: PublicKey;
  buffers?: ProofBufferStore;
  log?: (line: string) => void;
}): PoolRelayerChain {
  const conn = o.connection;
  const me = o.payer.publicKey;
  const log = o.log ?? (() => {});
  const buffers = o.buffers ?? memoryProofBufferStore();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function rpc<T>(f: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await f();
      } catch (e) {
        const m = String((e as Error).message ?? e);
        if (
          !/429|Too many|fetch failed|ECONNRESET|socket|503|502|timed out/i.test(
            m,
          ) ||
          attempt >= 6
        )
          throw e;
        await sleep(Math.min(30_000, 1_500 * 2 ** attempt));
      }
    }
  }
  const account = (k: PublicKey) =>
    rpc(() => conn.getAccountInfo(k, 'confirmed'));
  let alt: AddressLookupTableAccount | null | undefined;
  async function send(
    ixs: TransactionInstruction[],
    label: string,
    extra: Keypair[] = [],
    units = 400_000,
  ): Promise<string> {
    if (alt === undefined && o.lookupTable)
      alt = (await rpc(() => conn.getAddressLookupTable(o.lookupTable!))).value;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { blockhash, lastValidBlockHeight } = await rpc(() =>
        conn.getLatestBlockhash('confirmed'),
      );
      const msg = new TransactionMessage({
        payerKey: me,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units }),
          ...ixs,
        ],
      }).compileToV0Message(alt ? [alt] : []);
      const tx = new VersionedTransaction(msg);
      tx.sign([o.payer, ...extra]);
      let sig: string;
      try {
        sig = await rpc(() =>
          conn.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            maxRetries: 3,
          }),
        );
      } catch (e) {
        if (
          /Blockhash not found|block height exceeded/i.test(String(e)) &&
          attempt < 2
        )
          continue;
        const logs = (e as { logs?: string[] }).logs;
        throw new Error(
          `${label}: ${String((e as Error).message ?? e).slice(0, 200)}${logs ? ` | ${logs.slice(-3).join(' | ')}` : ''}`,
        );
      }
      for (let i = 0; i < 45; i++) {
        await sleep(2_000);
        const st = (await rpc(() => conn.getSignatureStatuses([sig]))).value[0];
        if (st?.err)
          throw new Error(
            `${label}: failed ${JSON.stringify(st.err)} (${sig})`,
          );
        if (
          st?.confirmationStatus === 'confirmed' ||
          st?.confirmationStatus === 'finalized'
        )
          return sig;
        if (
          (await rpc(() => conn.getBlockHeight('confirmed'))) >
          lastValidBlockHeight
        )
          break;
      }
    }
    throw new Error(`${label}: not confirmed`);
  }

  async function bitcoinConfig() {
    const a = await account(pda.bitcoin());
    if (!a) throw new Error('Bitcoin is not set up on this cluster');
    const c = decodeAccount<Raw>('BitcoinConfig', a.data);
    return {
      relay: c.relay as PublicKey,
      minConf: c.min_confirmations as number,
    };
  }
  const branch = (b: Uint8Array[]) => b.map((x) => Uint8Array.from(x));
  const writable = (k: PublicKey): AccountMeta => ({
    pubkey: k,
    isSigner: false,
    isWritable: true,
  });
  const proofAccounts = async (pool: PublicKey) => ({
    prover: me,
    bitcoin: pda.bitcoin(),
    relay: (await bitcoinConfig()).relay,
    pool,
    btc_vault: pda.btcVault(pool),
  });
  const coinOf = (pool: PublicKey, txid: Uint8Array, vout: number) =>
    pda.coin(pool, txid, vout);
  const provenOf = (pool: PublicKey, txid: Uint8Array) =>
    pda.proven(pool, txid);
  const display = (internal: Uint8Array) =>
    Array.from(Uint8Array.from(internal).reverse(), (x) =>
      x.toString(16).padStart(2, '0'),
    ).join('');
  const internal = (displayHex: string) =>
    Uint8Array.from(
      displayHex.match(/../g)!.map((h) => parseInt(h, 16)),
    ).reverse();

  return {
    async relayTip() {
      const a = await account((await bitcoinConfig()).relay);
      if (!a) throw new Error('no relay account');
      return new DataView(a.data.buffer, a.data.byteOffset).getUint32(52, true);
    },
    async submitHeaders(headers: Uint8Array[]) {
      const relay = (await bitcoinConfig()).relay;
      const data = concat(
        Uint8Array.from(SUBMIT_HEADERS),
        le(headers.length, 4),
        ...headers,
      );
      return send(
        [
          new TransactionInstruction({
            programId: BTC_RELAY_PROGRAM,
            keys: [
              { pubkey: me, isSigner: true, isWritable: false },
              { pubkey: relay, isSigner: false, isWritable: true },
            ],
            data: Buffer.from(data),
          }),
        ],
        'submit_headers',
      );
    },
    minConfirmations: async () => (await bitcoinConfig()).minConf,
    async pools(): Promise<RelayerPool[]> {
      const list = await rpc(() =>
        conn.getProgramAccounts(PROGRAM_ID, {
          commitment: 'confirmed',
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: base58(accountDiscriminator('Pool')),
              },
            },
          ],
        }),
      );
      const vaults: ({ data: Uint8Array } | null)[] = [];
      for (let i = 0; i < list.length; i += 100)
        vaults.push(
          ...(await rpc(() =>
            conn.getMultipleAccountsInfo(
              list.slice(i, i + 100).map((x) => pda.btcVault(x.pubkey)),
              'confirmed',
            ),
          )),
        );
      return list.map(({ pubkey, account: a }, i) => {
        const p = decodeAccount<Raw>('Pool', a.data);
        const lk = p.launch_key as Uint8Array;
        const vd = vaults[i]?.data;
        const v = vd ? decodeAccount<Raw>('BtcVault', vd) : null;
        return {
          pool: pubkey.toBase58(),
          status: p.status as number,
          runeBlock: p.rune_block as bigint,
          runeTx: p.rune_tx as number,
          runeName: p.rune_name as bigint,
          launchKey: lk.every((b) => b === 0)
            ? null
            : Array.from(lk, (x) => x.toString(16).padStart(2, '0')).join(''),
          vault: v
            ? {
                script: Array.from(
                  (v.script as Uint8Array).subarray(0, v.script_len as number),
                  (x) => x.toString(16).padStart(2, '0'),
                ).join(''),
                hasCoin: v.has_coin as boolean,
                coinTxid: display(v.coin_txid as Uint8Array),
                coinVout: v.coin_vout as number,
                pending: v.pending as bigint,
                batch: v.batch as bigint,
                alarm: v.alarm as boolean,
                batchSweeps: v.batch_sweeps as number,
              }
            : null,
        };
      });
    },
    async batchIds(pool: string, batch: bigint) {
      const list = await rpc(() =>
        conn.getProgramAccounts(PROGRAM_ID, {
          commitment: 'confirmed',
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: base58(accountDiscriminator('Withdrawal')),
              },
            },
            { memcmp: { offset: 10, bytes: pool } },
            {
              memcmp: {
                offset: 141,
                bytes: base58(Uint8Array.from([WD_IN_BATCH])),
              },
            },
            { memcmp: { offset: 142, bytes: base58(le(batch, 8)) } },
          ],
        }),
      );
      return list
        .map(
          (x) => decodeAccount<Raw>('Withdrawal', x.account.data).id as bigint,
        )
        .sort((a, b) => (a < b ? -1 : 1));
    },
    async activate(pool: string, p: RelayerProof) {
      const pk = new PublicKey(pool);
      return send(
        [
          instruction(
            'activate_by_proof',
            { height: p.height, raw_tx: p.rawTx, branch: branch(p.branch) },
            await proofAccounts(pk),
          ),
        ],
        'activate_by_proof',
        [],
        600_000,
      );
    },
    async activateNamed(pool: string, np: RelayerNamedProof) {
      const pk = new PublicKey(pool);
      const payload = Uint8Array.from(np.payload);
      const space = 44 + payload.length;
      const close = (k: Keypair) =>
        send(
          [
            instruction(
              'buffer_close',
              {},
              { authority: me, buffer: k.publicKey },
            ),
          ],
          'buffer_close',
        );
      let buffer = await buffers.load(pool);
      let a = buffer ? await account(buffer.publicKey) : null;
      if (
        buffer &&
        a &&
        (a.data.length !== space ||
          new DataView(a.data.buffer, a.data.byteOffset).getUint32(40, true) !==
            payload.length)
      ) {
        await close(buffer); // an older proof (another size): rent back, start again
        a = null;
        buffer = null;
      }
      if (!buffer || !a) {
        buffer ??= Keypair.generate();
        await buffers.save(pool, buffer);
        const rent = await rpc(() =>
          conn.getMinimumBalanceForRentExemption(space),
        );
        const have = await rpc(() => conn.getBalance(me));
        if (have < rent + 20_000_000)
          throw new Error(
            `the proof buffer needs ${rent / 1e9} SOL of rent (back when it closes); the keeper has ${have / 1e9}`,
          );
        await send(
          [
            SystemProgram.createAccount({
              fromPubkey: me,
              newAccountPubkey: buffer.publicKey,
              lamports: rent,
              space,
              programId: PROGRAM_ID,
            }),
            instruction(
              'buffer_init',
              { len: payload.length },
              { authority: me, buffer: buffer.publicKey },
            ),
          ],
          'buffer_init',
          [buffer],
        );
      }
      const CHUNK = 900;
      const have = (await account(buffer.publicKey))!.data;
      let writes = 0;
      for (let off = 0; off < payload.length; off += CHUNK) {
        const part = payload.subarray(off, off + CHUNK);
        const now = have.subarray(44 + off, 44 + off + part.length);
        if (now.length === part.length && now.every((x, i) => x === part[i]))
          continue;
        await send(
          [
            instruction(
              'buffer_write',
              { offset: off, data: part },
              { authority: me, buffer: buffer.publicKey },
            ),
          ],
          'buffer_write',
        );
        writes++;
      }
      log(
        `${pool.slice(0, 6)}..: proof buffer ${buffer.publicKey.toBase58()} written (${payload.length} bytes, ${writes} writes)`,
      );
      const sig = await send(
        [
          instruction(
            'activate_named',
            { commit_height: np.commitHeight, commit_index: np.commitIndex },
            { ...(await proofAccounts(pk)), buffer: buffer.publicKey },
          ),
        ],
        'activate_named',
        [],
        600_000,
      );
      await close(buffer);
      await buffers.clear(pool);
      return sig;
    },
    async proveVaultSpend(
      pool: string,
      p: RelayerProof,
      ids: bigint[],
      sweeps: string[],
    ) {
      const pk = new PublicKey(pool);
      return send(
        [
          instruction(
            'prove_vault_spend',
            {
              height: p.height,
              raw_tx: p.rawTx,
              index: p.index,
              branch: branch(p.branch),
            },
            await proofAccounts(pk),
            [
              ...ids.map((id) => writable(pda.withdrawal(pk, id))),
              ...sweeps.map((s) => writable(new PublicKey(s))),
            ],
          ),
        ],
        'prove_vault_spend',
        [],
        1_000_000,
      );
    },
    async unregistered(pool: string) {
      const list = await rpc(() =>
        conn.getProgramAccounts(PROGRAM_ID, {
          commitment: 'confirmed',
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: base58(accountDiscriminator('Withdrawal')),
              },
            },
            { memcmp: { offset: 10, bytes: pool } },
            {
              memcmp: {
                offset: 141,
                bytes: base58(Uint8Array.from([WD_DELIVERED])),
              },
            },
          ],
        }),
      );
      return list
        .map((x) => decodeAccount<Raw>('Withdrawal', x.account.data))
        .filter((w) => (w.reserved as Uint8Array)[0] === 0)
        .map((w) => w.id as bigint)
        .sort((a, b) => (a < b ? -1 : 1));
    },
    async registerCoin(pool: string, id: bigint) {
      const pk = new PublicKey(pool);
      const wk = pda.withdrawal(pk, id);
      const a = await account(wk);
      if (!a) throw new Error(`withdrawal ${id} is gone`);
      const w = decodeAccount<Raw>('Withdrawal', a.data);
      return send(
        [
          instruction(
            'register_withdrawal_coin',
            {},
            {
              payer: me,
              withdrawal: wk,
              coin: coinOf(pk, w.txid as Uint8Array, w.vout as number),
            },
          ),
        ],
        'register_withdrawal_coin',
      );
    },
    async coins(pool: string): Promise<RelayerCoin[]> {
      const list = await rpc(() =>
        conn.getProgramAccounts(PROGRAM_ID, {
          commitment: 'confirmed',
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: base58(accountDiscriminator('KnownCoin')),
              },
            },
            { memcmp: { offset: 10, bytes: pool } },
          ],
        }),
      );
      return list.map((x) => {
        const c = decodeAccount<Raw>('KnownCoin', x.account.data);
        const owner = c.owner as PublicKey;
        return {
          address: x.pubkey.toBase58(),
          txid: display(c.txid as Uint8Array),
          vout: c.vout as number,
          runes: c.runes as bigint,
          deposit: c.kind === COIN_DEPOSIT,
          owner: owner.equals(PublicKey.default) ? null : owner.toBase58(),
          credited: c.credited as boolean,
        };
      });
    },
    proven: async (pool: string, txid: string) =>
      !!(await account(provenOf(new PublicKey(pool), internal(txid)))),
    async proveCoinSpend(
      pool: string,
      p: RelayerProof,
      inputs: string[],
      outputs: number[],
    ) {
      const pk = new PublicKey(pool);
      const txid = Uint8Array.from(p.txid);
      return send(
        [
          instruction(
            'prove_coin_spend',
            {
              txid,
              height: p.height,
              raw_tx: p.rawTx,
              index: p.index,
              branch: branch(p.branch),
              inputs: inputs.length,
              outputs,
            },
            { ...(await proofAccounts(pk)), proven: provenOf(pk, txid) },
            [
              ...inputs.map((s) => writable(new PublicKey(s))),
              ...outputs.map((v) => writable(coinOf(pk, txid, v))),
            ],
          ),
        ],
        'prove_coin_spend',
        [],
        1_000_000,
      );
    },
    async creditDeposit(pool: string, c: RelayerCoin) {
      const pk = new PublicKey(pool);
      const owner = new PublicKey(c.owner!);
      return send(
        [
          instruction(
            'credit_deposit',
            {},
            {
              payer: me,
              pool: pk,
              btc_vault: pda.btcVault(pk),
              coin: new PublicKey(c.address),
              owner,
              balance: pda.balance(pk, owner),
            },
          ),
        ],
        'credit_deposit',
      );
    },
  };
}

/**
 * A complete keeper anyone can run: Solana (the program and the relay),
 * Bitcoin (an Esplora server, mempool.space by default) and the vault
 * canister (`keeperVault(await createVaultCanister())` from
 * `@etchydotfun/rune-pool/vault`). `tick()` once a minute.
 */
export function createKeeper(o: {
  connection: Connection;
  payer: Keypair;
  vault: PoolRelayerVault;
  bitcoin?: PoolRelayerBitcoin;
  store?: PoolRelayerStore;
  lookupTable?: PublicKey;
  buffers?: ProofBufferStore;
  log?: (line: string) => void;
}) {
  return createPoolRelayer({
    chain: solanaKeeperChain(o),
    bitcoin: o.bitcoin ?? esplora(),
    vault: o.vault,
    store: o.store ?? memoryPoolRelayerStore(),
    log: o.log,
  });
}
