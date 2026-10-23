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
  creditedRunes,
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
/** The mainnet lookup table (the same accounts, plus the Etchy API's). */
export const MAINNET_LOOKUP_TABLE = new PublicKey(
  'C6DTPV3SKeunnPvtbbzZbjLNFG2u5nhFN2ognYiyUN4g',
);
/** btc-relay `submit_headers` / `submit_headers_from` (Anchor discriminators). */
const SUBMIT_HEADERS = [151, 116, 247, 16, 199, 207, 48, 40];
const SUBMIT_HEADERS_FROM = [139, 58, 65, 119, 133, 101, 34, 99];
/** btc-relay `Relay` layout: the ring of 2,048 entries of 96 bytes at 264 (after the discriminator). */
const RELAY_RING = 264;
const RELAY_ENTRY = 96;
const RELAY_RING_LEN = 2048;
const WD_IN_BATCH = 1;
const WD_DELIVERED = 2;
const COIN_DEPOSIT = 1;
/** `ProvenTx` with `units` (re-proofs); older markers are 76 bytes. */
const PROVEN_SPACE = 8 + 32 + 32 + 4 + 16;
type Raw = Record<string, unknown>;

/**
 * Where a proof buffer's key is kept while it is written and used (resume
 * after a restart). Keys: a pool (named Rune proofs) or
 * `tx-<pool>-<txid>` (a big transaction's proof).
 */
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
  async function lookup(): Promise<AddressLookupTableAccount[]> {
    if (alt === undefined)
      alt = o.lookupTable
        ? (await rpc(() => conn.getAddressLookupTable(o.lookupTable!))).value
        : null;
    return alt ? [alt] : [];
  }
  const message = (
    ixs: TransactionInstruction[],
    units: number,
    blockhash: string,
    tables: AddressLookupTableAccount[],
  ) =>
    new TransactionMessage({
      payerKey: me,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units }),
        ...ixs,
      ],
    }).compileToV0Message(tables);
  /** These instructions fit one transaction (1,232 bytes, signatures included). */
  async function fits(ixs: TransactionInstruction[], units: number) {
    try {
      const m = message(
        ixs,
        units,
        PublicKey.default.toBase58(),
        await lookup(),
      );
      return (
        1 + 64 * m.header.numRequiredSignatures + m.serialize().length <= 1232
      );
    } catch {
      return false; // more than a message holds
    }
  }
  async function send(
    ixs: TransactionInstruction[],
    label: string,
    extra: Keypair[] = [],
    units = 400_000,
  ): Promise<string> {
    const tables = await lookup();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { blockhash, lastValidBlockHeight } = await rpc(() =>
        conn.getLatestBlockhash('confirmed'),
      );
      const msg = message(ixs, units, blockhash, tables);
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
  /** The relay's block hash at `height` (display order); null: not kept. */
  async function relayHashOf(height: number) {
    const relay = (await bitcoinConfig()).relay;
    const a = await rpc(() =>
      conn.getAccountInfo(relay, {
        commitment: 'confirmed',
        dataSlice: {
          offset: RELAY_RING + (height % RELAY_RING_LEN) * RELAY_ENTRY,
          length: RELAY_ENTRY,
        },
      }),
    );
    if (!a || a.data.length < RELAY_ENTRY) return null;
    const e = Uint8Array.from(a.data);
    // An old slot holds another height (the ring wraps).
    if (new DataView(e.buffer).getUint32(80, true) !== height) return null;
    return display(e.subarray(0, 32));
  }
  /**
   * The remembered blocks a proof needs: those of `heights` the relay no
   * longer keeps (the keeper remembers them first), as last accounts.
   */
  async function knownBlocks(heights: number[]): Promise<AccountMeta[]> {
    const relay = (await bitcoinConfig()).relay;
    const out: AccountMeta[] = [];
    for (const h of [...new Set(heights)])
      if ((await relayHashOf(h)) === null)
        out.push({
          pubkey: pda.knownBlock(relay, h),
          isSigner: false,
          isWritable: false,
        });
    return out;
  }
  const internal = (displayHex: string) =>
    Uint8Array.from(
      displayHex.match(/../g)!.map((h) => parseInt(h, 16)),
    ).reverse();

  /**
   * Writes `payload` into a proof buffer (kept under `key` in the store, so
   * a restart resumes it), runs `use` with it, then closes it (rent back),
   * also when `use` fails (the next try writes it again).
   */
  async function inBuffer(
    key: string,
    payload: Uint8Array,
    use: (buffer: PublicKey) => Promise<string>,
  ): Promise<string> {
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
    let buffer = await buffers.load(key);
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
      await buffers.save(key, buffer);
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
      `${key.slice(0, 12)}..: proof buffer ${buffer.publicKey.toBase58()} written (${payload.length} bytes, ${writes} writes)`,
    );
    try {
      return await use(buffer.publicKey);
    } finally {
      try {
        await close(buffer);
        await buffers.clear(key);
      } catch (e) {
        log(
          `${key.slice(0, 12)}..: buffer close failed (retried next time): ${String((e as Error).message ?? e).slice(0, 120)}`,
        );
      }
    }
  }
  /** named.rs `TxPayload`: the transaction, its branch, the block's coinbase if needed. */
  const txPayload = (p: RelayerProof) => {
    const bytes = (b: Uint8Array) =>
      concat(le(b.length, 4), Uint8Array.from(b));
    const br = (bs: Uint8Array[]) =>
      concat(
        Uint8Array.from([bs.length]),
        ...bs.map((x) => Uint8Array.from(x)),
      );
    return p.coinbase
      ? concat(
          bytes(p.rawTx),
          br(p.branch),
          bytes(p.coinbase.rawTx),
          br(p.coinbase.branch),
        )
      : concat(bytes(p.rawTx), br(p.branch));
  };
  /**
   * `prove_coin_spend` (first proof) or `reprove_coin_spend` (inputs known
   * since): EVERY input's coin record address, in order (a known coin is
   * counted, no record counts zero), then the outputs that get Runes.
   */
  async function coinSpend(
    name: 'prove_coin_spend' | 'reprove_coin_spend',
    pool: string,
    p: RelayerProof,
    inputs: { txid: string; vout: number }[],
    outputs: number[],
  ) {
    const pk = new PublicKey(pool);
    const txid = Uint8Array.from(p.txid);
    const accounts = {
      ...(await proofAccounts(pk)),
      proven: provenOf(pk, txid),
    };
    const rest = [
      ...inputs.map((i) => writable(coinOf(pk, internal(i.txid), i.vout))),
      ...outputs.map((v) => writable(coinOf(pk, txid, v))),
      ...(await knownBlocks([p.height])),
    ];
    const args = {
      txid,
      height: p.height,
      index: p.index,
      inputs: inputs.length,
      outputs,
    };
    return proveWith(
      name,
      `tx-${pool}-${display(txid)}`,
      p,
      async () =>
        instruction(
          name,
          { ...args, raw_tx: p.rawTx, branch: branch(p.branch) },
          accounts,
          rest,
        ),
      async (buffer) =>
        instruction(`${name}_buffered`, args, { ...accounts, buffer }, rest),
      1_000_000,
    );
  }
  /**
   * A proof inline when it fits one transaction (and needs no block depth),
   * else from a buffer: `inline` / `buffered` build the instruction.
   */
  async function proveWith(
    label: string,
    key: string,
    p: RelayerProof,
    inline: () => Promise<TransactionInstruction>,
    buffered: (buffer: PublicKey) => Promise<TransactionInstruction>,
    units: number,
  ): Promise<string> {
    const ix = await inline();
    if (!p.coinbase && (await fits([ix], units)))
      return send([ix], label, [], units);
    return inBuffer(key, txPayload(p), async (buffer) =>
      send([await buffered(buffer)], `${label}_buffered`, [], units),
    );
  }

  return {
    async relayTip() {
      const a = await account((await bitcoinConfig()).relay);
      if (!a) throw new Error('no relay account');
      return new DataView(a.data.buffer, a.data.byteOffset).getUint32(52, true);
    },
    relayHash: relayHashOf,
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
    async submitHeadersFrom(headers: Uint8Array[]) {
      const relay = (await bitcoinConfig()).relay;
      const payload = concat(...headers.map((h) => Uint8Array.from(h)));
      return inBuffer(
        `headers-${display(headers[0].subarray(4, 36))}`,
        payload,
        (buffer) =>
          send(
            [
              new TransactionInstruction({
                programId: BTC_RELAY_PROGRAM,
                keys: [
                  { pubkey: me, isSigner: true, isWritable: false },
                  { pubkey: relay, isSigner: false, isWritable: true },
                  { pubkey: buffer, isSigner: false, isWritable: false },
                ],
                // The payload starts after the buffer's 44-byte header.
                data: Buffer.from(
                  concat(
                    Uint8Array.from(SUBMIT_HEADERS_FROM),
                    le(44, 4),
                    le(headers.length, 2),
                  ),
                ),
              }),
            ],
            'submit_headers_from',
            [],
            1_400_000,
          ),
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
      const accounts = await proofAccounts(pk);
      const rest = await knownBlocks([p.height]);
      return proveWith(
        'activate_by_proof',
        `tx-${pool}-${display(p.txid)}`,
        p,
        async () =>
          instruction(
            'activate_by_proof',
            { height: p.height, raw_tx: p.rawTx, branch: branch(p.branch) },
            accounts,
            rest,
          ),
        async (buffer) =>
          instruction(
            'activate_by_proof_buffered',
            { height: p.height },
            { ...accounts, buffer },
            rest,
          ),
        600_000,
      );
    },
    async activateNamed(pool: string, np: RelayerNamedProof) {
      const pk = new PublicKey(pool);
      const accounts = await proofAccounts(pk);
      const pa = await account(pk);
      if (!pa) throw new Error('no such pool');
      const etched = Number(decodeAccount<Raw>('Pool', pa.data).rune_block);
      const rest = await knownBlocks([etched, np.commitHeight]);
      return inBuffer(pool, Uint8Array.from(np.payload), async (buffer) =>
        send(
          [
            instruction(
              'activate_named',
              { commit_height: np.commitHeight, commit_index: np.commitIndex },
              { ...accounts, buffer },
              rest,
            ),
          ],
          'activate_named',
          [],
          600_000,
        ),
      );
    },
    async proveVaultSpend(
      pool: string,
      p: RelayerProof,
      ids: bigint[],
      inputs: { txid: string; vout: number }[],
    ) {
      const pk = new PublicKey(pool);
      const txid = Uint8Array.from(p.txid);
      // The vault transaction is marked proven, so it can never be proven
      // again as a coin spend.
      const accounts = {
        ...(await proofAccounts(pk)),
        proven: provenOf(pk, txid),
      };
      const rest = [
        ...ids.map((id) => writable(pda.withdrawal(pk, id))),
        // Every input but the vault coin: its coin record address.
        ...inputs.map((i) => writable(coinOf(pk, internal(i.txid), i.vout))),
        ...(await knownBlocks([p.height])),
      ];
      return proveWith(
        'prove_vault_spend',
        `tx-${pool}-${display(txid)}`,
        p,
        async () =>
          instruction(
            'prove_vault_spend',
            {
              txid,
              height: p.height,
              raw_tx: p.rawTx,
              index: p.index,
              branch: branch(p.branch),
            },
            accounts,
            rest,
          ),
        async (buffer) =>
          instruction(
            'prove_vault_spend_buffered',
            { txid, height: p.height, index: p.index },
            { ...accounts, buffer },
            rest,
          ),
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
          // All of it (a re-proof may add Runes to a credited deposit).
          credited: creditedRunes(c) >= (c.runes as bigint),
        };
      });
    },
    proven: async (pool: string, txid: string) =>
      !!(await account(provenOf(new PublicKey(pool), internal(txid)))),
    async provenUnits(pool: string, txid: string) {
      const a = await account(provenOf(new PublicKey(pool), internal(txid)));
      if (!a || a.data.length < PROVEN_SPACE) return null;
      return decodeAccount<Raw>('ProvenTx', a.data).units as bigint;
    },
    proveCoinSpend: (pool, p, inputs, outputs) =>
      coinSpend('prove_coin_spend', pool, p, inputs, outputs),
    reproveCoinSpend: (pool, p, inputs, outputs) =>
      coinSpend('reprove_coin_spend', pool, p, inputs, outputs),
    remembered: async (height: number) =>
      !!(await account(pda.knownBlock((await bitcoinConfig()).relay, height))),
    async rememberBlock(
      height: number,
      headers: Uint8Array[],
      anchor: number | null,
    ) {
      const relay = (await bitcoinConfig()).relay;
      const payload = concat(...headers.map((h) => Uint8Array.from(h)));
      return inBuffer(`block-${height}`, payload, (buffer) =>
        send(
          [
            instruction(
              'remember_block',
              { height },
              {
                payer: me,
                bitcoin: pda.bitcoin(),
                relay,
                buffer,
                block: pda.knownBlock(relay, height),
                anchor: anchor === null ? null : pda.knownBlock(relay, anchor),
              },
            ),
          ],
          'remember_block',
          [],
          1_400_000,
        ),
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
