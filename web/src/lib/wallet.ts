import { BrowserProvider, Contract, ethers } from "ethers";
import { create } from "zustand";
import { api } from "./api";
import type { Config } from "./types";

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<any>; on?(ev: string, fn: (...a: any[]) => void): void };
type Announced = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193 };

const discovered: Announced[] = [];
if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (e: any) => {
    if (!discovered.some((d) => d.info.uuid === e.detail.info.uuid)) discovered.push(e.detail);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** Prefers BridgeKey (MST's wallet); falls back to any injected EIP-1193 wallet. */
export function findWallet(): { provider: Eip1193; name: string } | null {
  const bk = discovered.find((d) => /bridge\s*key/i.test(d.info.name) || /bridgekey/i.test(d.info.rdns));
  if (bk) return { provider: bk.provider, name: bk.info.name };
  if (discovered[0]) return { provider: discovered[0].provider, name: discovered[0].info.name };
  const eth = (window as any).ethereum as (Eip1193 & { isBridgeKey?: boolean }) | undefined;
  if (eth) return { provider: eth, name: eth.isBridgeKey ? "BridgeKey" : "Browser wallet" };
  return null;
}

async function ensureChain(provider: Eip1193, cfg: Config) {
  const current = parseInt(await provider.request({ method: "eth_chainId" }), 16);
  if (current === cfg.chainId) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: cfg.chainIdHex }] });
  } catch (err: any) {
    if (err?.code === 4902 || /unrecognized|not added|unknown chain/i.test(err?.message ?? "")) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: cfg.chainIdHex,
            chainName: cfg.networkLabel,
            nativeCurrency: { name: "MST", symbol: "MSTC", decimals: 18 },
            rpcUrls: [cfg.rpcUrl],
            blockExplorerUrls: cfg.explorerUrl ? [cfg.explorerUrl] : [],
          },
        ],
      });
    } else throw err;
  }
}

type WalletState = {
  address: string | null;
  name: string | null;
  officer: boolean;
  balanceMstc: string | null;
  connecting: boolean;
  error: string | null;
  connect: (cfg: Config) => Promise<void>;
  refresh: () => Promise<void>;
  disconnect: () => void;
};

export const useWallet = create<WalletState>((set, get) => ({
  address: null,
  name: null,
  officer: false,
  balanceMstc: null,
  connecting: false,
  error: null,
  connect: async (cfg) => {
    const w = findWallet();
    if (!w) {
      set({ error: "No BridgeKey wallet detected. Install the BridgeKey extension and reload." });
      return;
    }
    set({ connecting: true, error: null });
    try {
      const [addr] = await w.provider.request({ method: "eth_requestAccounts" });
      await ensureChain(w.provider, cfg);
      set({ address: ethers.getAddress(addr), name: w.name });
      w.provider.on?.("accountsChanged", (accs: string[]) => {
        set({ address: accs[0] ? ethers.getAddress(accs[0]) : null });
        get().refresh();
      });
      await get().refresh();
    } catch (err: any) {
      set({ error: err?.shortMessage ?? err?.message ?? String(err) });
    } finally {
      set({ connecting: false });
    }
  },
  refresh: async () => {
    const address = get().address;
    if (!address) return set({ officer: false, balanceMstc: null });
    try {
      const r = await api<{ officer: boolean; admin: boolean; balanceMstc: string }>(`/chain/role/${address}`);
      set({ officer: r.officer, balanceMstc: r.balanceMstc });
    } catch {
      /* chain offline */
    }
  },
  disconnect: () => set({ address: null, name: null, officer: false, balanceMstc: null }),
}));

let abiCache: any[] | null = null;

/** Signs a ledger call in BridgeKey and returns the transaction hash. */
export async function sendLedgerTx(cfg: Config, method: string, args: unknown[]): Promise<string> {
  const w = findWallet();
  if (!w) throw new Error("BridgeKey wallet not found");
  await ensureChain(w.provider, cfg);
  if (!abiCache) abiCache = (await api<{ abi: any[] }>("/chain/abi")).abi;
  const provider = new BrowserProvider(w.provider as any);
  const signer = await provider.getSigner();
  const contract = new Contract(cfg.contract!.address, abiCache, signer);
  const tx = await contract[method](...args);
  return tx.hash as string;
}
