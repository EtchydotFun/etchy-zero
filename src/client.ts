import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import { base58, Reader } from './borsh.ts';
import {
  afterBuy,
  afterSell,
  priceE18,
  quoteBuy,
  quoteBuyExactOut,
  quoteSell,
  withSlippage,
  type BuyQuote,
  type FeeRate,
  type Reserves,
  type SellQuote,
} from './math.ts';
import {
  approveMessage,
  depositMemo,
  formatSpacedRune,
  nearAddressOk,
  p2trAddress,
  poolNetwork,
  scriptAddress,
  sendWbtcMessage,
  taprootKey,
  tradeMessage,
  type PoolNetwork,
  type RuneLabel,
} from './messages.ts';
import {
  accountDiscriminator,
  decodeAccount,
  eventsFromLogs,
  instruction,
  pda,
  PROGRAM_ID,
} from './program.ts';
import {
  BTC_USD_ACCOUNT,
  minSwapOut,
  nearWithdrawAllowed,
  nearWithdrawFloor,
  parsePyth,
  priceUsable,
  satsForLamports,
  SOL_USD_ACCOUNT,
  type PythPrice,
  type SolSwapSettings,
} from './solswap.ts';

const SYSVAR_INSTRUCTIONS = new PublicKey(
  'Sysvar1nstructions1111111111111111111111111',
);

export const TOKEN_PROGRAM = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);
export const ATA_PROGRAM = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);
export const POOL_PENDING = 0;
export const POOL_ACTIVE = 1;
/** A launch pool trading before Bitcoin's proof of its etching (no Runes out yet). */
export const POOL_EARLY = 2;

/** A wallet's associated token account. */
export const tokenAccount = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()],
    ATA_PROGRAM,
  )[0];
/** Creates `owner`'s token account for `mint` if missing (`payer` pays the rent). */
export function createTokenAccountIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tokenAccount(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** SPL Token `InitializeAccount3`: `account` (created for the token program) holds `mint` for `owner`. */
export function initializeTokenAccountIx(
  account: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([18]), Buffer.from(owner.toBytes())]),
  });
}

/** One fee mode: each side's fee and the creator's part (bps); the rest is Etchy's. */
export interface FeeMode {
  enabled: boolean;
  buy: FeeRate;
  sell: FeeRate;
}
export interface PoolConfig {
  admin: PublicKey;
  feeAuthority: PublicKey;
  /** The BTC side of every pool (WBTC). */
  quoteMint: PublicKey;
  paused: boolean;
  modes: FeeMode[];
  poolCount: bigint;
  /** What every signed message names ("Etchy Zero (mainnet):"). */
  network: PoolNetwork;
  /** Only new launches get pools (never undone). */
  launchOnly: boolean;
  /** Every launch pool's starting market cap (virtual BTC, sats); 0: any. */
  startMcap: bigint;
}
export interface PoolState extends RuneLabel {
  address: PublicKey;
  /** `block:tx`. */
  runeId: string;
  name: string;
  symbol: string | null;
  supply: bigint;
  status: number;
  /** It trades: proven, or early (see `early`). */
  active: boolean;
  /** Bitcoin's proof is in: the supply is in the vault, Runes go out to Bitcoin and come back. */
  proven: boolean;
  /** Trading before the proof: no Runes out yet; buys stop at `earlyUntil` (unix seconds) unless proven by then. */
  early: boolean;
  earlyUntil: number | null;
  paused: boolean;
  reserves: Reserves;
  mode: number;
  creator: PublicKey;
  /** Unclaimed fees in the pool (WBTC sats): the creator's part and Etchy's. */
  creatorFees: bigint;
  protocolFees: bigint;
  /** The pool's WBTC account. */
  vault: PublicKey;
  createdAt: number;
  trades: bigint;
  volumeBtc: bigint;
  launchKey: Uint8Array | null;
  /** Sats per whole Rune, 18 decimals. */
  priceE18: bigint;
  /**
   * The creator's first buy (sats) and who gets it: until it is made, or
   * `firstBuyUntil` (unix seconds) passes, nobody trades. Null: none (or made).
   */
  firstBuy: { sats: bigint; buyer: PublicKey; until: number } | null;
  /** Its creator fees follow its fee route (`feeRouteOf`): anyone pays them out. */
  feeRouted: boolean;
}
export interface FeeRouteState {
  pool: PublicKey;
  /** Owners (a Solana wallet, or a Bitcoin wallet's owner address) and shares (bps). */
  entries: { owner: PublicKey; bps: number }[];
  /** Creator fees paid out through it, ever (sats). */
  paid: bigint;
}
export interface RuneBalanceState {
  address: PublicKey;
  pool: PublicKey;
  owner: PublicKey;
  amount: bigint;
  delegate: PublicKey | null;
  delegatedAmount: bigint;
}
export interface VaultState {
  /** Where Runes come back in (deposits, with `depositMemo`). */
  address: string | null;
  script: Uint8Array;
  hasCoin: boolean;
  runesInVault: bigint;
  withdrawn: bigint;
  pending: bigint;
  nextWithdrawal: bigint;
  batch: bigint;
  alarm: boolean;
}
export type WithdrawalStatus = 'pending' | 'in-batch' | 'delivered';
export interface WithdrawalState {
  address: PublicKey;
  pool: PublicKey;
  id: bigint;
  owner: PublicKey;
  amount: bigint;
  /** WBTC sats paid for it (back on cancel). */
  fee: bigint;
  /** Where the Runes go (output script) and its address. */
  script: Uint8Array;
  to: string | null;
  status: WithdrawalStatus;
  batch: bigint;
  requestedAt: number;
  /** The Bitcoin transaction that paid it (display order), once delivered. */
  txid: string | null;
  vout: number | null;
  deliveredHeight: number | null;
  /** Delivered and its output recorded: it can be closed (rent back). */
  closable: boolean;
  rentPayer: PublicKey;
}
export interface TradeRecord {
  signature: string;
  slot: number;
  time: number | null;
  pool: PublicKey;
  owner: PublicKey;
  signer: PublicKey;
  isBuy: boolean;
  /** WBTC the trader paid (buy) or got (sale). */
  btcAmount: bigint;
  runeAmount: bigint;
  fee: { total: bigint; creator: bigint; protocol: bigint };
  priceE18: bigint;
  reserves: Reserves;
}

type Raw = Record<string, unknown>;
const zeroKey = (k: PublicKey) => k.equals(PublicKey.default);

function poolState(address: PublicKey, p: Raw): PoolState {
  const reserves = {
    btcReal: p.btc_real as bigint,
    btcVirtual: p.btc_virtual as bigint,
    rune: p.rune_reserve as bigint,
  };
  const lk = p.launch_key as Uint8Array;
  const sym = p.symbol as number;
  const label = {
    runeName: p.rune_name as bigint,
    spacers: p.spacers as number,
    runeBlock: p.rune_block as bigint,
    runeTx: p.rune_tx as number,
    divisibility: p.divisibility as number,
  };
  return {
    address,
    ...label,
    runeId: `${label.runeBlock}:${label.runeTx}`,
    name: formatSpacedRune(label.runeName, label.spacers),
    symbol: sym ? String.fromCodePoint(sym) : null,
    supply: p.supply as bigint,
    status: p.status as number,
    active: p.status === POOL_ACTIVE || p.status === POOL_EARLY,
    proven: p.status === POOL_ACTIVE,
    early: p.status === POOL_EARLY,
    earlyUntil:
      p.status === POOL_EARLY ? Number(p.early_until as bigint) : null,
    paused: p.paused as boolean,
    reserves,
    mode: p.mode as number,
    creator: p.creator as PublicKey,
    creatorFees: p.creator_fees as bigint,
    protocolFees: p.protocol_fees as bigint,
    vault: p.vault as PublicKey,
    createdAt: Number(p.created_at as bigint),
    trades: p.trades as bigint,
    volumeBtc: p.volume_btc as bigint,
    launchKey: lk.every((b) => b === 0) ? null : lk,
    priceE18: priceE18(reserves, label.divisibility),
    firstBuy:
      (p.first_buy as bigint) > 0n
        ? {
            sats: p.first_buy as bigint,
            buyer: p.first_buyer as PublicKey,
            until: Number(p.first_buy_until as bigint),
          }
        : null,
    feeRouted: p.fee_routed as boolean,
  };
}

export type Side = 'buy' | 'sell';
export interface Quote {
  side: Side;
  /** Sats in (buy) or Rune units in (sale). */
  amountIn: bigint;
  /** Rune units out (buy) or sats out (sale). */
  amountOut: bigint;
  /** The trade's fee (sats): the creator's part and Etchy's. */
  fee: { total: bigint; creator: bigint; protocol: bigint };
  priceBeforeE18: bigint;
  priceAfterE18: bigint;
  /** Price move of this trade (bps). */
  impactBps: number;
  /** `amountOut` less the slippage allowance: pass it as the minimum. */
  minOut: bigint;
}

/**
 * The rune-pool client: everything etchy.fun does, for any platform. It
 * only reads chain state and builds instructions; the caller's wallet
 * signs and sends them (or Etchy's relay does, for Bitcoin wallets).
 * Etchy's fee is taken by the program on every trade, whoever sends it.
 */
export function createRunePoolClient(o: {
  connection: Connection;
  programId?: PublicKey;
}) {
  const conn = o.connection;
  const programId = o.programId ?? PROGRAM_ID;
  if (!programId.equals(PROGRAM_ID))
    throw new Error(
      'this SDK is generated for program ' + PROGRAM_ID.toBase58(),
    );
  let configCache: { at: number; value: PoolConfig } | null = null;

  async function account(k: PublicKey) {
    return conn.getAccountInfo(k, 'confirmed');
  }

  async function getConfig(fresh = false): Promise<PoolConfig> {
    if (!fresh && configCache && Date.now() - configCache.at < 30_000)
      return configCache.value;
    const a = await account(pda.config());
    if (!a) throw new Error('rune-pool is not initialized on this cluster');
    const c = decodeAccount<Raw>('Config', a.data);
    const value: PoolConfig = {
      admin: c.admin as PublicKey,
      feeAuthority: c.fee_authority as PublicKey,
      quoteMint: c.quote_mint as PublicKey,
      paused: c.paused as boolean,
      poolCount: c.pool_count as bigint,
      network: poolNetwork(c.quote_mint as PublicKey),
      launchOnly: c.launch_only as boolean,
      startMcap: c.start_mcap as bigint,
      modes: (c.modes as Raw[]).map((m) => ({
        enabled: m.enabled as boolean,
        buy: {
          feeBps: m.buy_fee_bps as number,
          creatorBps: m.buy_creator_bps as number,
        },
        sell: {
          feeBps: m.sell_fee_bps as number,
          creatorBps: m.sell_creator_bps as number,
        },
      })),
    };
    configCache = { at: Date.now(), value };
    return value;
  }

  async function getPool(pool: PublicKey): Promise<PoolState | null> {
    const a = await account(pool);
    return a ? poolState(pool, decodeAccount<Raw>('Pool', a.data)) : null;
  }
  const poolOfRune = (block: bigint | number, tx: number) =>
    pda.pool(block, tx);

  async function listPools(): Promise<PoolState[]> {
    const list = await conn.getProgramAccounts(programId, {
      commitment: 'confirmed',
      filters: [
        { memcmp: { offset: 0, bytes: base58(accountDiscriminator('Pool')) } },
      ],
    });
    return list.map((x) =>
      poolState(x.pubkey, decodeAccount<Raw>('Pool', x.account.data)),
    );
  }

  function balanceState(address: PublicKey, b: Raw): RuneBalanceState {
    const d = b.delegate as PublicKey;
    return {
      address,
      pool: b.pool as PublicKey,
      owner: b.owner as PublicKey,
      amount: b.amount as bigint,
      delegate: zeroKey(d) ? null : d,
      delegatedAmount: b.delegated_amount as bigint,
    };
  }
  async function getBalance(
    pool: PublicKey,
    owner: PublicKey,
  ): Promise<RuneBalanceState> {
    const address = pda.balance(pool, owner);
    const a = await account(address);
    if (!a)
      return {
        address,
        pool,
        owner,
        amount: 0n,
        delegate: null,
        delegatedAmount: 0n,
      };
    return balanceState(address, decodeAccount<Raw>('RuneBalance', a.data));
  }
  /** Every pool balance of an owner (a Solana wallet or a Bitcoin wallet's owner address). */
  async function balancesOf(owner: PublicKey): Promise<RuneBalanceState[]> {
    const list = await conn.getProgramAccounts(programId, {
      commitment: 'confirmed',
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: base58(accountDiscriminator('RuneBalance')),
          },
        },
        { memcmp: { offset: 42, bytes: owner.toBase58() } },
      ],
    });
    return list.map((x) =>
      balanceState(x.pubkey, decodeAccount<Raw>('RuneBalance', x.account.data)),
    );
  }

  async function fees(pool: PoolState) {
    const m = (await getConfig()).modes[pool.mode];
    if (!m?.enabled) throw new Error(`fee mode ${pool.mode} is off`);
    return m;
  }

  /** The exact result the program will give on the pool as it is now. */
  async function quote(
    pool: PoolState,
    side: Side,
    amountIn: bigint,
    slippageBps = 100,
  ): Promise<Quote> {
    const mode = await fees(pool);
    const before = pool.reserves;
    let out: bigint;
    let fee: Quote['fee'];
    let after: Reserves;
    if (side === 'buy') {
      const q: BuyQuote = quoteBuy(before, amountIn, mode.buy);
      out = q.runeOut;
      fee = q.fee;
      after = afterBuy(before, q);
    } else {
      const q: SellQuote = quoteSell(before, amountIn, mode.sell);
      out = q.btcOut;
      fee = q.fee;
      after = afterSell(before, q);
    }
    const p0 = priceE18(before, pool.divisibility);
    const p1 = priceE18(after, pool.divisibility);
    const impactBps =
      p0 === 0n ? 0 : Number(((p1 > p0 ? p1 - p0 : p0 - p1) * 10_000n) / p0);
    return {
      side,
      amountIn,
      amountOut: out,
      fee,
      priceBeforeE18: p0,
      priceAfterE18: p1,
      impactBps,
      minOut: withSlippage(out, slippageBps),
    };
  }
  /** Sats needed to buy at least `runeOut` units. */
  async function quoteExactOut(pool: PoolState, runeOut: bigint) {
    return quoteBuyExactOut(pool.reserves, runeOut, (await fees(pool)).buy);
  }

  /** The program's own quote (simulated); `payer`: any existing account. */
  async function quoteOnChain(
    pool: PublicKey,
    side: Side,
    amount: bigint,
    payer: PublicKey,
  ) {
    const ix = instruction(
      'quote',
      { is_buy: side === 'buy', amount },
      { config: pda.config(), pool },
    );
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions: [ix],
      }).compileToV0Message(),
    );
    const sim = await conn.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
    });
    if (sim.value.err)
      throw new Error(`quote: ${JSON.stringify(sim.value.err)}`);
    const data = sim.value.returnData?.data?.[0];
    if (!data) throw new Error('quote: no return data');
    const r = new Reader(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    return {
      amountOut: r.uint(16),
      fee: { total: r.uint(8), creator: r.uint(8), protocol: r.uint(8) },
    };
  }

  // ------------------------------------------------------------ Solana wallet
  /**
   * Buy with WBTC from `trader`'s WBTC account; the Runes go to
   * `recipient`'s balance (default: the trader). Also returns the quote.
   */
  async function buy(p: {
    pool: PoolState;
    trader: PublicKey;
    btcIn: bigint;
    minRuneOut: bigint;
    recipient?: PublicKey;
    traderWbtc?: PublicKey;
  }): Promise<TransactionInstruction[]> {
    const cfg = await getConfig();
    const recipient = p.recipient ?? p.trader;
    return [
      instruction(
        'buy',
        { btc_in: p.btcIn, min_rune_out: p.minRuneOut },
        {
          trader: p.trader,
          config: pda.config(),
          pool: p.pool.address,
          vault: p.pool.vault,
          trader_token: p.traderWbtc ?? tokenAccount(p.trader, cfg.quoteMint),
          recipient,
          balance: pda.balance(p.pool.address, recipient),
        },
      ),
    ];
  }
  /** Sell from `owner`'s balance (signed by the owner or its delegate); WBTC to `destination`. */
  async function sell(p: {
    pool: PoolState;
    signer: PublicKey;
    runeIn: bigint;
    minBtcOut: bigint;
    owner?: PublicKey;
    destination?: PublicKey;
    createDestination?: boolean;
  }): Promise<TransactionInstruction[]> {
    const cfg = await getConfig();
    const owner = p.owner ?? p.signer;
    const dest = p.destination ?? tokenAccount(owner, cfg.quoteMint);
    const ixs: TransactionInstruction[] = [];
    if (p.createDestination ?? !p.destination)
      ixs.push(createTokenAccountIx(p.signer, owner, cfg.quoteMint));
    ixs.push(
      instruction(
        'sell',
        { rune_in: p.runeIn, min_btc_out: p.minBtcOut },
        {
          signer: p.signer,
          config: pda.config(),
          pool: p.pool.address,
          vault: p.pool.vault,
          balance: pda.balance(p.pool.address, owner),
          destination: dest,
        },
      ),
    );
    return ixs;
  }
  /** Runes from one balance to another owner (instant, inside the pool). */
  function transferRunes(p: {
    pool: PublicKey;
    signer: PublicKey;
    from: PublicKey;
    to: PublicKey;
    amount: bigint;
    payer?: PublicKey;
  }) {
    return [
      instruction(
        'transfer_runes',
        { amount: p.amount },
        {
          signer: p.signer,
          payer: p.payer ?? p.signer,
          pool: p.pool,
          from: pda.balance(p.pool, p.from),
          to_owner: p.to,
          to: pda.balance(p.pool, p.to),
        },
      ),
    ];
  }

  // ------------------------------------------------------------ creator fees
  /** A pool's fee route (null: none; its creator fees are Etchy's to pay to holders). */
  async function feeRouteOf(pool: PublicKey): Promise<FeeRouteState | null> {
    const a = await account(pda.feeRoute(pool));
    if (!a) return null;
    const r = decodeAccount<Raw>('FeeRoute', a.data);
    const n = r.count as number;
    if (!n) return null;
    return {
      pool,
      entries: (r.entries as Raw[]).slice(0, n).map((e) => ({
        owner: e.owner as PublicKey,
        bps: e.bps as number,
      })),
      paid: r.paid as bigint,
    };
  }
  /**
   * Anyone: pays a routed pool's creator fees to its owners' WBTC accounts
   * (`payer` creates the missing ones and pays the Solana fee). Etchy is
   * not needed: the program sends each owner its share.
   *
   * An owner whose associated WBTC account now belongs to another key (it
   * gave it away) is paid into another WBTC account of its own (one it has,
   * or a new one the payer creates: its key is in `.signers`, the
   * transaction needs it), the given one following as the program's proof.
   */
  async function claimRouteFees(p: {
    pool: PublicKey;
    payer: PublicKey;
    /** Create missing WBTC accounts (default: yes; the payer pays their rent). */
    createAccounts?: boolean;
  }): Promise<TransactionInstruction[] & { signers: Keypair[] }> {
    const cfg = await getConfig();
    const route = await feeRouteOf(p.pool);
    if (!route) throw new Error('this pool has no fee route');
    const create = p.createAccounts !== false;
    const before: TransactionInstruction[] = [];
    const signers: Keypair[] = [];
    const rest: PublicKey[] = [];
    for (const e of route.entries) {
      const ata = tokenAccount(e.owner, cfg.quoteMint);
      const a = await account(ata);
      const holder =
        a && a.owner.equals(TOKEN_PROGRAM) && a.data.length >= 64
          ? new PublicKey(Uint8Array.from(a.data).subarray(32, 64))
          : null;
      if (!holder || holder.equals(e.owner)) {
        if (!a && create)
          before.push(createTokenAccountIx(p.payer, e.owner, cfg.quoteMint));
        rest.push(ata);
        continue;
      }
      // Its associated account belongs to another key now (audit A1-01).
      const own = (
        await conn.getTokenAccountsByOwner(
          e.owner,
          { mint: cfg.quoteMint },
          'confirmed',
        )
      ).value.find(
        (x) =>
          !x.pubkey.equals(ata) &&
          new PublicKey(
            Uint8Array.from(x.account.data).subarray(32, 64),
          ).equals(e.owner),
      );
      let to = own?.pubkey;
      if (!to) {
        if (!create)
          throw new Error(
            `${e.owner.toBase58()} gave its WBTC account away: a new one is needed (createAccounts)`,
          );
        const k = Keypair.generate();
        signers.push(k);
        before.push(
          SystemProgram.createAccount({
            fromPubkey: p.payer,
            newAccountPubkey: k.publicKey,
            lamports: await conn.getMinimumBalanceForRentExemption(165),
            space: 165,
            programId: TOKEN_PROGRAM,
          }),
          initializeTokenAccountIx(k.publicKey, cfg.quoteMint, e.owner),
        );
        to = k.publicKey;
      }
      rest.push(to, ata);
    }
    const ixs = [
      ...before,
      instruction(
        'claim_route_fees',
        {},
        {
          config: pda.config(),
          pool: p.pool,
          vault: pda.vault(p.pool),
          route: pda.feeRoute(p.pool),
        },
        rest.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
      ),
    ];
    return Object.assign(ixs, { signers });
  }

  // ------------------------------------------------------------ Bitcoin
  async function getVault(pool: PublicKey): Promise<VaultState | null> {
    const a = await account(pda.btcVault(pool));
    if (!a) return null;
    const v = decodeAccount<Raw>('BtcVault', a.data);
    const script = (v.script as Uint8Array).subarray(0, v.script_len as number);
    return {
      address: p2trAddress(script),
      script,
      hasCoin: v.has_coin as boolean,
      runesInVault: v.coin_runes as bigint,
      withdrawn: v.withdrawn as bigint,
      pending: v.pending as bigint,
      nextWithdrawal: v.next_withdrawal as bigint,
      batch: v.batch as bigint,
      alarm: v.alarm as boolean,
    };
  }
  /** Real Runes out to a Bitcoin address (`script`: its output script). The WBTC fee is paid from `feeToken`. */
  async function requestWithdrawal(p: {
    pool: PoolState;
    signer: PublicKey;
    owner?: PublicKey;
    amount: bigint;
    script: Uint8Array;
    payer?: PublicKey;
    feeToken?: PublicKey;
  }) {
    const cfg = await getConfig();
    const v = await getVault(p.pool.address);
    if (!v) throw new Error('this pool has no Bitcoin vault');
    const owner = p.owner ?? p.signer;
    const payer = p.payer ?? p.signer;
    return {
      id: v.nextWithdrawal,
      instructions: [
        instruction(
          'request_withdrawal',
          { amount: p.amount, script: p.script },
          {
            signer: p.signer,
            payer,
            bitcoin: pda.bitcoin(),
            pool: p.pool.address,
            vault: p.pool.vault,
            btc_vault: pda.btcVault(p.pool.address),
            balance: pda.balance(p.pool.address, owner),
            withdrawal: pda.withdrawal(p.pool.address, v.nextWithdrawal),
            fee_token: p.feeToken ?? tokenAccount(payer, cfg.quoteMint),
          },
        ),
      ],
    };
  }
  /** Where and how to send Runes back from Bitcoin so they are credited to `owner` (1-2 blocks). */
  async function depositInfo(pool: PublicKey, owner: PublicKey) {
    const v = await getVault(pool);
    if (!v?.address) throw new Error('this pool has no Bitcoin vault');
    return { vaultAddress: v.address, memoScript: depositMemo(owner) };
  }

  /** A Bitcoin wallet's owner address and accounts (its balances belong to this address). */
  async function bitcoinWallet(address: string) {
    const key = taprootKey(address);
    const owner = pda.btcOwner(key);
    const cfg = await getConfig();
    const a = await account(owner);
    const nonce = a
      ? (decodeAccount<Raw>('BtcOwner', a.data).nonce as bigint)
      : 0n;
    return {
      address,
      key,
      owner,
      wbtc: tokenAccount(owner, cfg.quoteMint),
      exists: !!a,
      nonce,
    };
  }
  /**
   * The wallet's signed buy or sale (`signature`: the 64-byte Schnorr
   * signature inside its BIP-322 signature). `submitter` pays the Solana fee.
   */
  async function btcTrade(p: {
    pool: PoolState;
    bitcoinKey: Uint8Array;
    isBuy: boolean;
    amount: bigint;
    minOut: bigint;
    nonce: bigint;
    expiry: bigint;
    signature: Uint8Array;
    submitter: PublicKey;
  }) {
    const cfg = await getConfig();
    const owner = pda.btcOwner(p.bitcoinKey);
    const ixs: TransactionInstruction[] = [];
    if (!(await account(owner)))
      ixs.push(
        instruction(
          'btc_owner_open',
          { key: p.bitcoinKey },
          { payer: p.submitter, btc_owner: owner },
        ),
      );
    ixs.push(createTokenAccountIx(p.submitter, owner, cfg.quoteMint));
    ixs.push(
      instruction(
        'btc_trade',
        {
          nonce: p.nonce,
          expiry: p.expiry,
          is_buy: p.isBuy,
          amount: p.amount,
          min_out: p.minOut,
          signature: p.signature,
        },
        {
          submitter: p.submitter,
          config: pda.config(),
          btc_owner: owner,
          pool: p.pool.address,
          vault: p.pool.vault,
          wbtc: tokenAccount(owner, cfg.quoteMint),
          balance: pda.balance(p.pool.address, owner),
        },
      ),
    );
    return ixs;
  }

  /** The Bitcoin wallet's next approval or order: the text it signs (BIP-322), its number and expiry. */
  async function btcOrderBasics(address: string, seconds: number) {
    const w = await bitcoinWallet(address);
    const cfg = await getConfig();
    return {
      wallet: w,
      network: cfg.network,
      nonce: w.nonce,
      expiry: BigInt(Math.floor(Date.now() / 1000) + seconds),
    };
  }
  /**
   * The text a Bitcoin wallet signs for one buy (`amount` sats of its WBTC)
   * or sale (`amount` Rune units); then `btcTrade` with the signature. Any
   * site can send it (no Etchy relay needed); Etchy's fee is taken on it
   * like on every trade.
   */
  async function btcTradeOrder(p: {
    pool: PoolState;
    bitcoinAddress: string;
    isBuy: boolean;
    amount: bigint;
    minOut: bigint;
    seconds?: number;
  }) {
    const b = await btcOrderBasics(p.bitcoinAddress, p.seconds ?? 120);
    return {
      text: tradeMessage(
        b.network,
        p.pool,
        p.isBuy,
        p.amount,
        p.minOut,
        b.nonce,
        b.expiry,
      ),
      nonce: b.nonce,
      expiry: b.expiry,
    };
  }
  /**
   * The text a Bitcoin wallet signs to let `delegate` (e.g. a browser
   * session key) sell, send or withdraw up to `amount` of its Runes in this
   * pool; 0 revokes. Then `btcApprove` with the signature.
   */
  async function btcApproveOrder(p: {
    pool: PoolState;
    bitcoinAddress: string;
    delegate: PublicKey;
    amount: bigint;
    seconds?: number;
  }) {
    const b = await btcOrderBasics(p.bitcoinAddress, p.seconds ?? 600);
    return {
      text: approveMessage(
        b.network,
        p.pool,
        p.delegate.toBase58(),
        p.amount,
        b.nonce,
        b.expiry,
      ),
      nonce: b.nonce,
      expiry: b.expiry,
    };
  }
  /** The signed approval. Anyone may send it (`submitter` pays the Solana fee). */
  async function btcApprove(p: {
    pool: PoolState;
    bitcoinKey: Uint8Array;
    delegate: PublicKey;
    amount: bigint;
    nonce: bigint;
    expiry: bigint;
    /** The 64-byte Schnorr signature (`bip322Signature` of the wallet's answer). */
    signature: Uint8Array;
    submitter: PublicKey;
  }) {
    const owner = pda.btcOwner(p.bitcoinKey);
    const ixs: TransactionInstruction[] = [];
    if (!(await account(owner)))
      ixs.push(
        instruction(
          'btc_owner_open',
          { key: p.bitcoinKey },
          { payer: p.submitter, btc_owner: owner },
        ),
      );
    ixs.push(
      instruction(
        'btc_approve',
        {
          nonce: p.nonce,
          expiry: p.expiry,
          delegate: p.delegate,
          amount: p.amount,
          signature: p.signature,
        },
        {
          submitter: p.submitter,
          config: pda.config(),
          btc_owner: owner,
          pool: p.pool.address,
          balance: pda.balance(p.pool.address, owner),
        },
      ),
    );
    return ixs;
  }
  /** The text a Bitcoin wallet signs to send `amount` sats of its WBTC to the Solana wallet `to`. */
  async function btcSendWbtcOrder(p: {
    bitcoinAddress: string;
    to: PublicKey;
    amount: bigint;
    seconds?: number;
  }) {
    const b = await btcOrderBasics(p.bitcoinAddress, p.seconds ?? 600);
    return {
      text: sendWbtcMessage(
        b.network,
        p.amount,
        p.to.toBase58(),
        b.nonce,
        b.expiry,
      ),
      nonce: b.nonce,
      expiry: b.expiry,
    };
  }
  /** The signed WBTC send (to `to`'s WBTC account, opened if needed). Anyone may send it. */
  async function btcSendWbtc(p: {
    bitcoinKey: Uint8Array;
    to: PublicKey;
    amount: bigint;
    nonce: bigint;
    expiry: bigint;
    signature: Uint8Array;
    submitter: PublicKey;
  }) {
    const cfg = await getConfig();
    const owner = pda.btcOwner(p.bitcoinKey);
    return [
      createTokenAccountIx(p.submitter, p.to, cfg.quoteMint),
      instruction(
        'btc_send_wbtc',
        {
          nonce: p.nonce,
          expiry: p.expiry,
          amount: p.amount,
          signature: p.signature,
        },
        {
          submitter: p.submitter,
          config: pda.config(),
          btc_owner: owner,
          source: tokenAccount(owner, cfg.quoteMint),
          destination: tokenAccount(p.to, cfg.quoteMint),
        },
      ),
    ];
  }

  // ------------------------------------------------------------ balances: approve, close
  /** Lets `delegate` (a key or a program) sell, send or withdraw up to `amount` of `owner`'s Runes; 0 revokes. */
  function approve(p: {
    pool: PublicKey;
    owner: PublicKey;
    delegate: PublicKey;
    amount: bigint;
  }) {
    return [
      instruction(
        'approve',
        { delegate: p.delegate, amount: p.amount },
        { owner: p.owner, balance: pda.balance(p.pool, p.owner) },
      ),
    ];
  }
  /**
   * Closes an EMPTY balance, signed by its owner or by whoever paid its rent
   * (`closer`; a Bitcoin wallet's balance can only be closed that way). The
   * rent goes back to whoever paid it, as the balance records (the owner
   * for balances opened before the payer was recorded).
   */
  async function closeBalance(p: {
    pool: PublicKey;
    owner: PublicKey;
    /** Who signs (default: the owner). */
    closer?: PublicKey;
  }) {
    const balance = pda.balance(p.pool, p.owner);
    const a = await account(balance);
    if (!a) throw new Error('no such balance');
    const b = decodeAccount<Raw>('RuneBalance', a.data);
    const payer = b.rent_payer as PublicKey;
    return [
      instruction(
        'close_balance',
        {},
        {
          closer: p.closer ?? p.owner,
          balance,
          rent_to: payer.equals(PublicKey.default) ? p.owner : payer,
        },
      ),
    ];
  }

  // ------------------------------------------------------------ withdrawals
  const WD_STATUS: WithdrawalStatus[] = ['pending', 'in-batch', 'delivered'];
  async function withdrawalState(
    address: PublicKey,
    w: Raw,
  ): Promise<WithdrawalState> {
    const status = WD_STATUS[w.status as number] ?? 'pending';
    const script = (w.script as Uint8Array).slice(0, w.script_len as number);
    const delivered = status === 'delivered';
    return {
      address,
      pool: w.pool as PublicKey,
      id: w.id as bigint,
      owner: w.owner as PublicKey,
      amount: w.amount as bigint,
      fee: w.fee as bigint,
      script,
      to: await scriptAddress(script).catch(() => null),
      status,
      batch: w.batch as bigint,
      requestedAt: Number(w.requested_at as bigint),
      txid: delivered
        ? Array.from(w.txid as Uint8Array)
            .reverse()
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        : null,
      vout: delivered ? (w.vout as number) : null,
      deliveredHeight: delivered ? (w.delivered_height as number) : null,
      closable: delivered && (w.reserved as Uint8Array)[0] === 1,
      rentPayer: w.rent_payer as PublicKey,
    };
  }
  async function getWithdrawal(pool: PublicKey, id: bigint) {
    const address = pda.withdrawal(pool, id);
    const a = await account(address);
    return a
      ? withdrawalState(address, decodeAccount<Raw>('Withdrawal', a.data))
      : null;
  }
  /**
   * An owner's withdrawals (a Solana wallet, or a Bitcoin wallet's owner
   * address), newest first; `pool` narrows to one pool. Closed ones are gone.
   */
  async function withdrawalsOf(owner: PublicKey, pool?: PublicKey) {
    const filters = [
      {
        memcmp: {
          offset: 0,
          bytes: base58(accountDiscriminator('Withdrawal')),
        },
      },
      { memcmp: { offset: 50, bytes: owner.toBase58() } },
    ];
    if (pool) filters.push({ memcmp: { offset: 10, bytes: pool.toBase58() } });
    const list = await conn.getProgramAccounts(programId, {
      commitment: 'confirmed',
      filters,
    });
    const out = await Promise.all(
      list.map((x) =>
        withdrawalState(
          x.pubkey,
          decodeAccount<Raw>('Withdrawal', x.account.data),
        ),
      ),
    );
    return out.sort((a, b) => b.requestedAt - a.requestedAt);
  }
  /**
   * Cancels a withdrawal still waiting (not in a Bitcoin batch yet): the
   * Runes back to the balance, the WBTC fee back to `refundTo` (default:
   * the owner's WBTC account, opened if needed; it must be the owner's when
   * the owner's delegate cancels), the rent back to whoever paid it.
   */
  async function cancelWithdrawal(p: {
    pool: PoolState;
    id: bigint;
    signer: PublicKey;
    payer?: PublicKey;
    refundTo?: PublicKey;
  }) {
    const w = await getWithdrawal(p.pool.address, p.id);
    if (!w) throw new Error(`no withdrawal ${p.id}`);
    if (w.status !== 'pending')
      throw new Error(`withdrawal ${p.id} is ${w.status}: too late to cancel`);
    const cfg = await getConfig();
    const payer = p.payer ?? p.signer;
    const ixs: TransactionInstruction[] = [];
    const refundTo = p.refundTo ?? tokenAccount(w.owner, cfg.quoteMint);
    if (!p.refundTo)
      ixs.push(createTokenAccountIx(payer, w.owner, cfg.quoteMint));
    ixs.push(
      instruction(
        'cancel_withdrawal',
        {},
        {
          signer: p.signer,
          payer,
          pool: p.pool.address,
          vault: p.pool.vault,
          btc_vault: pda.btcVault(p.pool.address),
          withdrawal: w.address,
          rent_payer: w.rentPayer,
          balance: pda.balance(p.pool.address, w.owner),
          refund_to: refundTo,
        },
      ),
    );
    return ixs;
  }
  /**
   * Closes a delivered withdrawal: its rent back to whoever paid it.
   * `closer`: the owner or the rent payer. If its Bitcoin output is not
   * recorded yet (keepers do it within minutes), this records it first
   * (`closer` pays that record's rent; it stays so the Runes can come back).
   */
  async function closeWithdrawal(p: {
    pool: PublicKey;
    id: bigint;
    closer: PublicKey;
  }) {
    const w = await getWithdrawal(p.pool, p.id);
    if (!w) throw new Error(`no withdrawal ${p.id} (closed already?)`);
    if (w.status !== 'delivered')
      throw new Error(
        `withdrawal ${p.id} is ${w.status}: not paid on Bitcoin yet`,
      );
    const ixs: TransactionInstruction[] = [];
    if (!w.closable)
      ixs.push(
        instruction(
          'register_withdrawal_coin',
          {},
          {
            payer: p.closer,
            withdrawal: w.address,
            coin: pda.coin(
              p.pool,
              Uint8Array.from(
                w.txid!.match(/../g)!.map((h) => parseInt(h, 16)),
              ).reverse(),
              w.vout!,
            ),
          },
        ),
      );
    ixs.push(
      instruction(
        'close_withdrawal',
        {},
        { closer: p.closer, withdrawal: w.address, rent_payer: w.rentPayer },
      ),
    );
    return ixs;
  }

  // ------------------------------------------------------------ trades
  /** A transaction's trades (from the program's events). */
  async function tradesOf(signature: string): Promise<TradeRecord[]> {
    let tx: Awaited<ReturnType<Connection['getTransaction']>> = null;
    for (let attempt = 0; ; attempt++) {
      try {
        tx = await conn.getTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        break;
      } catch (e) {
        // Public RPCs rate-limit getTransaction hard: wait and try again.
        if (attempt >= 3 || !/429|Too many requests/i.test(String(e))) throw e;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
    if (!tx?.meta?.logMessages || tx.meta.err) return [];
    return eventsFromLogs(tx.meta.logMessages, programId)
      .filter((e) => e.name === 'Trade')
      .map((e) => {
        const d = e.data;
        return {
          signature,
          slot: tx.slot,
          time: tx.blockTime ?? null,
          pool: d.pool as PublicKey,
          owner: d.owner as PublicKey,
          signer: d.signer as PublicKey,
          isBuy: d.is_buy as boolean,
          btcAmount: d.btc_amount as bigint,
          runeAmount: d.rune_amount as bigint,
          fee: {
            total: d.fee_total as bigint,
            creator: d.fee_creator as bigint,
            protocol: d.fee_protocol as bigint,
          },
          priceE18: d.price_e18 as bigint,
          reserves: {
            btcReal: d.btc_real as bigint,
            btcVirtual: d.btc_virtual as bigint,
            rune: d.rune_reserve as bigint,
          },
        };
      });
  }
  /**
   * The pool's latest trades (newest first). Pass a `cache` (signature ->
   * trades) to skip transactions already read: confirmed transactions never
   * change, so a server can keep one cache for all its callers.
   */
  async function recentTrades(
    pool: PublicKey,
    limit = 50,
    cache?: Map<string, TradeRecord[]>,
  ): Promise<TradeRecord[]> {
    const sigs = await conn.getSignaturesForAddress(
      pool,
      { limit },
      'confirmed',
    );
    const out: TradeRecord[] = [];
    for (const s of sigs) {
      if (s.err) continue;
      let trades = cache?.get(s.signature);
      if (!trades) {
        trades = await tradesOf(s.signature);
        cache?.set(s.signature, trades);
      }
      for (const t of trades) if (t.pool.equals(pool)) out.push(t);
    }
    return out;
  }

  // ------------------------------------------------------------ add BTC through NEAR (SOL -> WBTC)
  async function solSwapSettings(): Promise<SolSwapSettings> {
    const a = await account(pda.solSwap());
    if (!a) throw new Error('the SOL swap is not set up on this cluster');
    const s = decodeAccount<Raw>('SolSwapConfig', a.data).settings as Raw;
    const hx = (b: unknown) =>
      Array.from(b as Uint8Array, (x) => x.toString(16).padStart(2, '0')).join(
        '',
      );
    return {
      btcFeed: hx(s.btc_feed),
      solFeed: hx(s.sol_feed),
      maxAgeSecs: s.max_age_secs as number,
      maxConfBps: s.max_conf_bps as number,
      toleranceBps: s.tolerance_bps as number,
      swapFeeLamports: s.swap_fee_lamports as bigint,
      minLamports: s.min_lamports as bigint,
      paused: s.paused as boolean,
    };
  }
  /** A Bitcoin wallet's SOL deposit (where NEAR sends SOL) and swap addresses. */
  async function solDeposit(bitcoinKey: Uint8Array) {
    const owner = pda.btcOwner(bitcoinKey);
    const authority = pda.solSwapAuthority(owner);
    const cfg = await getConfig();
    const address = pda.btcSol(bitcoinKey);
    return {
      address,
      lamports: BigInt(await conn.getBalance(address, 'confirmed')),
      owner,
      authority,
      inbox: tokenAccount(authority, cfg.quoteMint),
      wbtc: tokenAccount(owner, cfg.quoteMint),
    };
  }
  /** Pyth's BTC/USD and SOL/USD now (the accounts the program reads). */
  async function pythPrices(
    s?: SolSwapSettings,
    accounts = { btc: BTC_USD_ACCOUNT, sol: SOL_USD_ACCOUNT },
  ): Promise<{ btc: PythPrice; sol: PythPrice }> {
    const settings = s ?? (await solSwapSettings());
    const [b, o] = await conn.getMultipleAccountsInfo(
      [accounts.btc, accounts.sol],
      'confirmed',
    );
    if (!b || !o) throw new Error('Pyth price accounts missing');
    return {
      btc: parsePyth(b.data, settings.btcFeed),
      sol: parsePyth(o.data, settings.solFeed),
    };
  }
  /** What swapping the wallet's deposited SOL must deliver now (null: nothing to swap). */
  async function solSwapQuote(bitcoinKey: Uint8Array) {
    const s = await solSwapSettings();
    const d = await solDeposit(bitcoinKey);
    const { btc, sol } = await pythPrices(s);
    const now = Math.floor(Date.now() / 1000);
    const usable = priceUsable(btc, s, now) && priceUsable(sol, s, now);
    return {
      ...d,
      settings: s,
      ready: !s.paused && usable && d.lamports >= s.minLamports,
      pricesUsable: usable,
      valueSats: satsForLamports(d.lamports, sol, btc),
      minOut: minSwapOut(d.lamports, sol, btc, s),
      /** SOL the sender gets to swap (the rest is its fee). */
      swapLamports:
        d.lamports > s.swapFeeLamports ? d.lamports - s.swapFeeLamports : 0n,
      prices: { btc, sol },
    };
  }
  /**
   * The swap transaction's instructions: the inbox and the wallet's WBTC
   * account (created if missing), `sol_swap_begin`, `route` (it must pay at
   * least `minOut` WBTC into `inbox`), `sol_swap_end`. `swapper` signs and
   * gets the SOL. `inboxBefore`: the inbox's balance now (0 if new).
   */
  async function solSwapInstructions(p: {
    swapper: PublicKey;
    bitcoinKey: Uint8Array;
    route: TransactionInstruction[];
    minOut: bigint;
    inboxBefore?: bigint;
    priceAccounts?: { btc: PublicKey; sol: PublicKey };
  }): Promise<TransactionInstruction[]> {
    const cfg = await getConfig();
    const owner = pda.btcOwner(p.bitcoinKey);
    const authority = pda.solSwapAuthority(owner);
    const inbox = tokenAccount(authority, cfg.quoteMint);
    const wbtc = tokenAccount(owner, cfg.quoteMint);
    let before = p.inboxBefore;
    if (before === undefined) {
      const a = await account(inbox);
      before = a ? new Reader(a.data.subarray(64, 72)).uint(8) : 0n;
    }
    const prices = p.priceAccounts ?? {
      btc: BTC_USD_ACCOUNT,
      sol: SOL_USD_ACCOUNT,
    };
    return [
      createTokenAccountIx(p.swapper, authority, cfg.quoteMint),
      createTokenAccountIx(p.swapper, owner, cfg.quoteMint),
      instruction(
        'sol_swap_begin',
        { key: p.bitcoinKey },
        {
          swapper: p.swapper,
          settings: pda.solSwap(),
          deposit: pda.btcSol(p.bitcoinKey),
          owner,
          swap_authority: authority,
          config: pda.config(),
          inbox,
          btc_price: prices.btc,
          sol_price: prices.sol,
          instructions: SYSVAR_INSTRUCTIONS,
        },
      ),
      ...p.route,
      instruction(
        'sol_swap_end',
        { key: p.bitcoinKey, inbox_before: before, min_out: p.minOut },
        {
          rent_to: p.swapper,
          config: pda.config(),
          settings: pda.solSwap(),
          owner,
          swap_authority: authority,
          inbox,
          destination: wbtc,
        },
      ),
    ];
  }

  // ------------------------------------------------------------ withdraw to Bitcoin through NEAR
  /**
   * Whether the program accepts selling `amount` sats of a wallet's WBTC
   * for `minLamports` now, and the least SOL it accepts (`floor`).
   */
  async function nearWithdrawCheck(amount: bigint, minLamports?: bigint) {
    const s = await solSwapSettings();
    const { btc, sol } = await pythPrices(s);
    const now = Math.floor(Date.now() / 1000);
    const usable = priceUsable(btc, s, now) && priceUsable(sol, s, now);
    const floor = nearWithdrawFloor(amount, sol, btc, s);
    return {
      settings: s,
      prices: { btc, sol },
      pricesUsable: usable,
      floor,
      ok:
        !s.paused &&
        usable &&
        nearWithdrawAllowed(amount, minLamports ?? floor, sol, btc, s),
    };
  }
  /**
   * The withdrawal transaction's instructions: the sender's WBTC account
   * (created if missing), `near_withdraw_begin` (the wallet's signed order;
   * `amount` WBTC to the sender), `route` (the sender's swap to SOL, if
   * any), `minLamports` of SOL from the sender to NEAR's `deposit`, and
   * `near_withdraw_end`. `submitter` signs. `depositBefore`: the deposit
   * address's lamports now (read if not given).
   */
  async function nearWithdrawInstructions(p: {
    submitter: PublicKey;
    bitcoinKey: Uint8Array;
    amount: bigint;
    minLamports: bigint;
    btcAddress: string;
    deposit: PublicKey;
    nonce: bigint;
    expiry: bigint;
    signature: Uint8Array;
    route?: TransactionInstruction[];
    senderWbtc?: PublicKey;
    depositBefore?: bigint;
    priceAccounts?: { btc: PublicKey; sol: PublicKey };
  }): Promise<TransactionInstruction[]> {
    if (!nearAddressOk(p.btcAddress)) throw new Error('bad Bitcoin address');
    const cfg = await getConfig();
    const owner = pda.btcOwner(p.bitcoinKey);
    const before =
      p.depositBefore ?? BigInt(await conn.getBalance(p.deposit, 'confirmed'));
    const prices = p.priceAccounts ?? {
      btc: BTC_USD_ACCOUNT,
      sol: SOL_USD_ACCOUNT,
    };
    const senderWbtc = p.senderWbtc ?? tokenAccount(p.submitter, cfg.quoteMint);
    // A wallet that only added BTC has no owner account yet (the submitter pays its rent).
    const open = !(await account(owner))
      ? [
          instruction(
            'btc_owner_open',
            { key: p.bitcoinKey },
            { payer: p.submitter, btc_owner: owner },
          ),
        ]
      : [];
    return [
      ...open,
      ...(p.senderWbtc
        ? []
        : [createTokenAccountIx(p.submitter, p.submitter, cfg.quoteMint)]),
      instruction(
        'near_withdraw_begin',
        {
          nonce: p.nonce,
          expiry: p.expiry,
          amount: p.amount,
          min_lamports: p.minLamports,
          btc_address: p.btcAddress,
          signature: p.signature,
        },
        {
          submitter: p.submitter,
          config: pda.config(),
          settings: pda.solSwap(),
          btc_owner: owner,
          wbtc: tokenAccount(owner, cfg.quoteMint),
          sender_wbtc: senderWbtc,
          deposit: p.deposit,
          btc_price: prices.btc,
          sol_price: prices.sol,
          instructions: SYSVAR_INSTRUCTIONS,
        },
      ),
      ...(p.route ?? []),
      SystemProgram.transfer({
        fromPubkey: p.submitter,
        toPubkey: p.deposit,
        lamports: p.minLamports,
      }),
      instruction(
        'near_withdraw_end',
        { before, min_lamports: p.minLamports },
        { deposit: p.deposit },
      ),
    ];
  }

  return {
    programId,
    connection: conn,
    getConfig,
    getPool,
    poolOfRune,
    listPools,
    getBalance,
    balancesOf,
    fees,
    quote,
    quoteExactOut,
    quoteOnChain,
    buy,
    sell,
    transferRunes,
    feeRouteOf,
    claimRouteFees,
    getVault,
    requestWithdrawal,
    depositInfo,
    bitcoinWallet,
    btcTrade,
    btcTradeOrder,
    btcApproveOrder,
    btcApprove,
    btcSendWbtcOrder,
    btcSendWbtc,
    approve,
    closeBalance,
    getWithdrawal,
    withdrawalsOf,
    cancelWithdrawal,
    closeWithdrawal,
    solSwapSettings,
    solDeposit,
    pythPrices,
    solSwapQuote,
    solSwapInstructions,
    nearWithdrawCheck,
    nearWithdrawInstructions,
    tradesOf,
    recentTrades,
    /** A compute-unit limit for a transaction of these instructions. */
    computeLimit: (units = 400_000) =>
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
  };
}
export type RunePoolClient = ReturnType<typeof createRunePoolClient>;
