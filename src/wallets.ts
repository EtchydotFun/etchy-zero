import { fromHex, hex } from './borsh.ts';
import { bip322Signature } from './messages.ts';

/**
 * Bitcoin wallets in the browser, one shape for all of them (Xverse,
 * UniSat, Leather, OKX). A site connects the user's wallet, then:
 *
 * - `signMessage(text)`: BIP-322 of an order, approval or withdrawal text
 *   (`btcTradeOrder`, `btcApproveOrder`, ...), by the Taproot address;
 *   `signOrder` also returns the 64 bytes the program checks;
 * - `signPsbt(psbt, signInputs)`: a deposit (`depositTransaction`) or any
 *   Bitcoin transaction, signed but not sent (finish with `finishDeposit`).
 *
 * Runes and pool balances belong to the Taproot (bc1p) address.
 * Single-address wallets (UniSat, OKX) must be on a Taproot address; then
 * it pays the fees too. No dependency: it talks to what the wallets inject
 * into the page. Import `@etchydotfun/rune-pool/wallets`.
 */
export type WalletId = 'xverse' | 'unisat' | 'leather' | 'okx';
export interface WalletAccount {
  address: string;
  /** Hex: x-only (32 bytes) or compressed (33 bytes). */
  publicKey: string;
}
export interface ConnectedWallet {
  id: WalletId;
  name: string;
  /** Runes and the pool balance (Taproot, bc1p). */
  ordinals: WalletAccount;
  /** Plain BTC for fees: the same as `ordinals` on single-address wallets. */
  payment: WalletAccount;
  /** BIP-322 "simple" signature of `text` by the Taproot address (base64). */
  signMessage(text: string): Promise<string>;
  /** Signs the listed inputs (index per address); not finalized, not sent. Base64 in and out. */
  signPsbt(
    psbtBase64: string,
    signInputs: Record<string, number[]>,
  ): Promise<string>;
}
export interface BitcoinWalletProvider {
  id: WalletId;
  name: string;
  /** Whether the wallet is in this browser. */
  installed(): boolean;
  /** Asks the user to connect (`message`: shown by wallets that show one). */
  connect(message?: string): Promise<ConnectedWallet>;
}
/** The user refused, or the wallet is not usable for this (its message says why). */
export class WalletError extends Error {
  readonly wallet: WalletId;
  constructor(wallet: WalletId, message: string) {
    super(message);
    this.wallet = wallet;
  }
}

const b64ToHex = (b64: string) =>
  hex(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const hexToB64 = (h: string) => {
  let s = '';
  for (const b of fromHex(h)) s += String.fromCharCode(b);
  return btoa(s);
};
const isTaproot = (a: string) => /^bc1p[02-9ac-hj-np-z]{58}$/.test(a);
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const why = (e: unknown, fallback: string) =>
  String(
    (e as Any)?.error?.message ??
      (e as Any)?.message ??
      (typeof e === 'string' ? e : fallback),
  );

function xverse(w: Any): BitcoinWalletProvider {
  const prov = () => w.XverseProviders?.BitcoinProvider ?? w.BitcoinProvider;
  const fail = (m: string): never => {
    throw new WalletError('xverse', m);
  };
  async function req(method: string, params: unknown) {
    let r: Any;
    try {
      r = await prov().request(method, params);
    } catch (e) {
      return fail(why(e, 'Xverse refused'));
    }
    if (r?.error) fail(why(r, 'Xverse refused'));
    return r?.result;
  }
  return {
    id: 'xverse',
    name: 'Xverse',
    installed: () => !!w.XverseProviders?.BitcoinProvider,
    async connect(message = 'Connect to trade Runes') {
      let list: Any[];
      try {
        list = (
          await req('wallet_connect', {
            addresses: ['ordinals', 'payment'],
            message,
          })
        ).addresses;
      } catch {
        list = await req('getAccounts', {
          purposes: ['ordinals', 'payment'],
          message,
        });
      }
      const ord = list?.find((a) => a.purpose === 'ordinals');
      const pay = list?.find((a) => a.purpose === 'payment') ?? ord;
      if (!ord || !pay || !isTaproot(ord.address))
        return fail('Xverse gave no Taproot (bc1p) Ordinals address (mainnet)');
      const ordinals = { address: ord.address, publicKey: ord.publicKey };
      return {
        id: 'xverse',
        name: 'Xverse',
        ordinals,
        payment: { address: pay.address, publicKey: pay.publicKey },
        async signMessage(text) {
          const r = await req('signMessage', {
            address: ordinals.address,
            message: text,
            protocol: 'BIP322',
          });
          return r?.signature ?? fail('Xverse returned no signature');
        },
        async signPsbt(psbt, signInputs) {
          const r = await req('signPsbt', {
            psbt,
            signInputs,
            broadcast: false,
          });
          return r?.psbt ?? fail('Xverse returned no signed transaction');
        },
      };
    },
  };
}

/** UniSat and OKX: one address, the same calls (OKX: `connect` instead of `requestAccounts`). */
function single(
  id: 'unisat' | 'okx',
  name: string,
  get: () => Any | undefined,
): BitcoinWalletProvider {
  const fail = (m: string): never => {
    throw new WalletError(id, m);
  };
  const call = async <T>(f: () => Promise<T>) => {
    try {
      return await f();
    } catch (e) {
      return fail(why(e, `${name} refused`));
    }
  };
  return {
    id,
    name,
    installed: () => !!get(),
    async connect() {
      const u = get() ?? fail(`${name} is not installed`);
      let address: string;
      let publicKey: string;
      if (id === 'okx') {
        const r = await call<Any>(() => u.connect());
        address = r?.address;
        publicKey = r?.publicKey;
      } else {
        address = (await call<string[]>(() => u.requestAccounts()))?.[0];
        publicKey = await call<string>(() => u.getPublicKey());
      }
      if (typeof u.getNetwork === 'function') {
        const n = await call<string>(() => u.getNetwork());
        if (n && n !== 'livenet') fail(`switch ${name} to Bitcoin mainnet`);
      }
      if (!address || !isTaproot(address))
        fail(`switch ${name} to a Taproot (bc1p) address`);
      const acct = { address, publicKey };
      return {
        id,
        name,
        ordinals: acct,
        payment: acct,
        signMessage: (text) =>
          call<string>(() => u.signMessage(text, 'bip322-simple')),
        async signPsbt(psbt, signInputs) {
          const toSignInputs = Object.entries(signInputs).flatMap(
            ([addr, idx]) => idx.map((index) => ({ index, address: addr })),
          );
          const signed = await call<string>(() =>
            u.signPsbt(b64ToHex(psbt), { autoFinalized: false, toSignInputs }),
          );
          return hexToB64(signed);
        },
      };
    },
  };
}

function leather(w: Any): BitcoinWalletProvider {
  const fail = (m: string): never => {
    throw new WalletError('leather', m);
  };
  async function req(method: string, params?: unknown) {
    let r: Any;
    try {
      r = await w.LeatherProvider.request(method, params);
    } catch (e) {
      return fail(why(e, 'Leather refused'));
    }
    if (r?.error) fail(why(r, 'Leather refused'));
    return r?.result;
  }
  return {
    id: 'leather',
    name: 'Leather',
    installed: () => !!w.LeatherProvider,
    async connect() {
      const list: Any[] = (await req('getAddresses'))?.addresses ?? [];
      const btc = list.filter((a) => a.symbol === 'BTC' || !a.symbol);
      const tr = btc.find((a) => a.type === 'p2tr');
      const pay = btc.find((a) => a.type === 'p2wpkh') ?? tr;
      if (!tr || !pay || !isTaproot(tr.address))
        return fail('Leather gave no Taproot (bc1p) address (mainnet)');
      return {
        id: 'leather',
        name: 'Leather',
        ordinals: { address: tr.address, publicKey: tr.publicKey },
        payment: { address: pay.address, publicKey: pay.publicKey },
        async signMessage(text) {
          const r = await req('signMessage', {
            message: text,
            paymentType: 'p2tr',
            network: 'mainnet',
          });
          return r?.signature ?? fail('Leather returned no signature');
        },
        async signPsbt(psbt, signInputs) {
          const r = await req('signPsbt', {
            hex: b64ToHex(psbt),
            signAtIndex: Object.values(signInputs)
              .flat()
              .sort((a, b) => a - b),
            network: 'mainnet',
            broadcast: false,
          });
          return r?.hex
            ? hexToB64(r.hex)
            : fail('Leather returned no signed transaction');
        },
      };
    },
  };
}

/** Every supported wallet (installed or not), in this order. */
export function bitcoinWallets(
  w: Any = globalThis as Any,
): BitcoinWalletProvider[] {
  return [
    xverse(w),
    single('unisat', 'UniSat', () => w.unisat),
    leather(w),
    single('okx', 'OKX Wallet', () => w.okxwallet?.bitcoin),
  ];
}
/** The wallets installed in this browser. */
export const installedWallets = (w: Any = globalThis as Any) =>
  bitcoinWallets(w).filter((x) => x.installed());

/**
 * Has the wallet sign an order, approval or withdrawal text: the wallet's
 * answer (send it to Etchy's relay as is) and the 64-byte signature the
 * program checks (for `btcTrade`, `btcApprove`, `btcSendWbtc`).
 */
export async function signOrder(wallet: ConnectedWallet, text: string) {
  const signature = await wallet.signMessage(text);
  const raw = bip322Signature(signature);
  if (!raw)
    throw new WalletError(
      wallet.id,
      `${wallet.name} did not sign with its Taproot key (BIP-322)`,
    );
  return { signature, raw };
}
