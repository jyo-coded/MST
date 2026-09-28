import mst from "@mstblockchain/mst-sdk";
import { ethers } from "ethers";
import { config, explorerTx, loadDeployment, type Deployment } from "./config";
import { makeDomain } from "./eip712";
import { emit } from "./events";

const { Client } = mst;

export const JOB_STATUS = ["None", "Open", "Accepted", "Settled", "Rejected", "Expired"] as const;
export type JobStatusName = (typeof JOB_STATUS)[number];

export type TxResult = {
  hash: string;
  url: string | null;
  blockNumber: number;
  gasUsed: string;
  events: { name: string; args: Record<string, unknown> }[];
};

export class ChainRevert extends Error {
  constructor(
    public readonly method: string,
    public readonly reason: string,
  ) {
    super(`${method} would revert: ${reason}`);
  }
}

/**
 * All on-chain access goes through here. The MST SDK Client supplies the
 * JSON-RPC provider and the relayer signer (it wraps ethers v6); contract
 * calls use ethers.Contract on top of the SDK's wallet.
 */
export class Chain {
  readonly client: InstanceType<typeof Client>;
  readonly provider: ethers.JsonRpcProvider;
  readonly relayer: ethers.Wallet;
  readonly guardian: ethers.Wallet | null;
  readonly admin: ethers.Wallet | null;
  readonly deployment: Deployment;
  readonly vault: ethers.Contract;
  readonly domain: ethers.TypedDataDomain;
  private queue: Promise<unknown> = Promise.resolve();

  constructor() {
    const deployment = loadDeployment();
    if (!deployment && !config.contractAddress) {
      throw new Error(
        `No deployment for network "${config.network}". Run \`npm run deploy:${config.network === "localhost" ? "local" : config.network}\` first.`,
      );
    }
    if (!config.keys.relayer) throw new Error("Set RELAYER_PRIVATE_KEY (or ADMIN_PRIVATE_KEY) in .env");

    this.client = new Client(config.rpcUrl, config.keys.relayer);
    this.provider = this.client.provider.ethersProvider;
    this.provider.pollingInterval = 1000;
    this.relayer = this.client.signer!.ethersWallet;
    this.guardian = config.keys.guardian ? new ethers.Wallet(config.keys.guardian) : null;
    this.admin = config.keys.admin ? new ethers.Wallet(config.keys.admin, this.provider) : null;

    this.deployment = {
      ...(deployment as Deployment),
      address: config.contractAddress || deployment!.address,
    };
    this.vault = new ethers.Contract(this.deployment.address, this.deployment.abi, this.relayer);
    this.domain = makeDomain(config.chainId, this.deployment.address);
  }

  // ----------------------------------------------------------------- reads

  async status() {
    const [blockNumber, relayerBalance, paused] = await Promise.all([
      this.client.provider.getBlockNumber(),
      this.client.provider.getBalance(this.relayer.address),
      this.vault.paused() as Promise<boolean>,
    ]);
    return { blockNumber, relayerBalance, paused };
  }

  balanceOf(address: string): Promise<bigint> {
    return this.client.provider.getBalance(address);
  }

  async getWard(wardId: bigint) {
    const w = await this.vault.getWard(wardId);
    return {
      policy: {
        basePayout: w.policy.basePayout as bigint,
        ratePerPoint: w.policy.ratePerPoint as bigint,
        maxPayoutPerJob: w.policy.maxPayoutPerJob as bigint,
        dailyCap: w.policy.dailyCap as bigint,
        serviceWindow: Number(w.policy.serviceWindow),
        minFillToHire: Number(w.policy.minFillToHire),
        minFillDelta: Number(w.policy.minFillDelta),
        minConfidence: Number(w.policy.minConfidence),
      },
      balance: w.balance as bigint,
      reserved: w.reserved as bigint,
      spentToday: w.spentToday as bigint,
      dayStart: Number(w.dayStart),
      exists: w.exists as boolean,
    };
  }

  async getBin(binId: bigint) {
    const b = await this.vault.getBin(binId);
    return {
      device: b.device as string,
      wardId: b.wardId as bigint,
      activeJobId: b.activeJobId as bigint,
      lastNonce: b.lastNonce as bigint,
      active: b.active as boolean,
    };
  }

  async getCollector(collectorId: bigint) {
    const c = await this.vault.getCollector(collectorId);
    return {
      device: c.device as string,
      payout: c.payout as string,
      tagHash: c.tagHash as string,
      active: c.active as boolean,
      completedJobs: Number(c.completedJobs),
      rejectedJobs: Number(c.rejectedJobs),
      totalEarned: c.totalEarned as bigint,
    };
  }

  async getJob(jobId: bigint) {
    const j = await this.vault.getJob(jobId);
    return {
      binId: j.binId as bigint,
      wardId: j.wardId as bigint,
      collectorId: j.collectorId as bigint,
      fillAtHire: Number(j.fillAtHire),
      status: JOB_STATUS[Number(j.status)],
      openedAt: Number(j.openedAt),
      acceptedAt: Number(j.acceptedAt),
      deadline: Number(j.deadline),
      reserved: j.reserved as bigint,
      payout: j.payout as bigint,
      evidenceDigest: j.evidenceDigest as string,
      reportHash: j.reportHash as string,
    };
  }

  quotePayout(wardId: bigint, fillDelta: bigint): Promise<bigint> {
    return this.vault.quotePayout(wardId, fillDelta);
  }

  // ---------------------------------------------------------------- writes

  /**
   * Simulates first (so a revert costs no gas and we get the exact reason),
   * then sends from the relayer. Sends are serialised to keep nonces sane.
   */
  send(method: string, args: unknown[], opts: { signer?: ethers.Wallet; label?: string } = {}): Promise<TxResult> {
    const run = async () => {
      const contract = opts.signer ? (this.vault.connect(opts.signer) as ethers.Contract) : this.vault;
      const label = opts.label ?? method;
      try {
        await contract[method].staticCall(...args);
      } catch (err) {
        throw new ChainRevert(method, this.decodeError(err));
      }
      const tx: ethers.TransactionResponse = await contract[method](...args);
      emit("tx:sent", "info", `${label} sent`, { hash: tx.hash, url: explorerTx(tx.hash), method });
      // Wait through the MST SDK provider wrapper.
      const receipt = await this.client.provider.waitForTransaction(tx.hash);
      if (!receipt || receipt.status !== 1) throw new ChainRevert(method, `transaction ${tx.hash} failed on-chain`);
      const events = receipt.logs
        .map((log) => {
          try {
            const parsed = this.vault.interface.parseLog(log);
            return parsed ? { name: parsed.name, args: argsToObject(parsed) } : null;
          } catch {
            return null;
          }
        })
        .filter((e): e is { name: string; args: Record<string, unknown> } => e !== null);
      const result: TxResult = {
        hash: tx.hash,
        url: explorerTx(tx.hash),
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        events,
      };
      emit("tx:confirmed", "success", `${label} confirmed in block ${receipt.blockNumber}`, result);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Dry-run only: returns the revert reason, or null if the call would succeed. */
  async preflight(method: string, args: unknown[]): Promise<string | null> {
    try {
      await this.vault[method].staticCall(...args);
      return null;
    } catch (err) {
      return this.decodeError(err);
    }
  }

  decodeError(err: unknown): string {
    const e = err as any;
    if (e?.revert?.name) {
      const raw = (e.revert.args ?? []).map((a: unknown) => String(a));
      if (e.revert.name === "WrongJobStatus") return `WrongJobStatus(job ${raw[0]} is already ${JOB_STATUS[Number(raw[1])]})`;
      return `${e.revert.name}(${raw.join(", ")})`;
    }
    const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
    if (typeof data === "string" && data.length >= 10) {
      try {
        const parsed = this.vault.interface.parseError(data);
        if (parsed) return `${parsed.name}(${parsed.args.map(String).join(", ")})`;
      } catch {
        // fall through
      }
    }
    return e?.shortMessage ?? e?.reason ?? e?.message ?? String(err);
  }
}

function argsToObject(parsed: ethers.LogDescription): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  parsed.fragment.inputs.forEach((input, i) => {
    const v = parsed.args[i];
    out[input.name] = typeof v === "bigint" ? v.toString() : v;
  });
  return out;
}

let instance: Chain | null = null;
export function chain(): Chain {
  if (!instance) instance = new Chain();
  return instance;
}
