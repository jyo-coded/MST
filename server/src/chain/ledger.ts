import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mst from "@mstblockchain/mst-sdk";
import { ethers } from "ethers";
import { CHAIN_STATUS, type ChainStatus } from "@astra/shared";
import { config, explorerTx, ROOT_DIR } from "../config";
import { one, q } from "../db";
import { publish } from "../realtime";

const { Client } = mst;

export type SignerKind = "gateway" | "officer" | "admin";

export type TxMeta = {
  action: string;
  requestId?: number | null;
  binId?: string | null;
  workerId?: string | null;
  wallet?: string | null;
  valueWei?: bigint | string | null;
};

export type DecodedEvent = { name: string; args: Record<string, unknown> };

export type TxRow = {
  id: number;
  hash: string;
  action: string;
  method: string;
  status: "SUBMITTED" | "CONFIRMED" | "FAILED";
  request_id: number | null;
  bin_id: string | null;
  worker_id: string | null;
  from_address: string;
  to_address: string;
  wallet: string | null;
  value_wei: string | null;
  signer_kind: string;
  block_number: number | null;
  fee_wei: string | null;
  events: DecodedEvent[] | null;
  error: string | null;
  created_at: Date;
  confirmed_at: Date | null;
};

export class ChainError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
    /** "refused": the contract would revert, nothing was sent. "failed": sent and failed. */
    public readonly kind: "refused" | "failed" = "failed",
  ) {
    super(message);
  }
}

/** Contract errors in words an officer understands. */
export function humanizeReason(reason: string): string {
  const m = reason.match(/^(\w+)\((.*)\)$/);
  const [name, args] = m ? [m[1], m[2].split(",").map((s) => s.trim())] : [reason, [] as string[]];
  switch (name) {
    case "InsufficientRemoval":
      return `Only ${args[0]} fill points were removed; the ledger requires ${args[1]} before a collection can be approved.`;
    case "WrongStatus":
      return `The ledger has this request in a different state (${args.join(" ").replace(/^request \d+ is /, "")}).`;
    case "InsufficientFunds":
      return `The municipal fund has ${args[0]} wei free; ${args[1]} wei is needed. Top up the fund.`;
    case "AmountOutOfRange":
      return `Payment amount is outside the policy cap (max ${args[1]} wei).`;
    case "AccessControlUnauthorizedAccount":
      return `Wallet ${args[0]} does not have the required role on the ledger.`;
    case "EnforcedPause":
      return "The ledger is paused by the municipality.";
    case "BinBusy":
      return `${args[0]} already has an open request on-chain.`;
    case "BadSignature":
      return `The ${args[0]} signature did not verify.`;
    case "StaleNonce":
      return "This device message was already used (replay refused).";
    case "BadTimestamp":
      return "The device timestamp is outside the allowed window.";
    case "ConfidenceTooLow":
      return "AI confidence is below the ledger's minimum.";
    case "NotFullEnough":
      return `The bin is not full enough to request collection (${args[0]}% < ${args[1]}%).`;
    default:
      return reason;
  }
}

const artifact = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "WasteCollectionLedger.json"), "utf8"),
) as { abi: any[]; bytecode: string };

export const LEDGER_ABI = artifact.abi;
export const LEDGER_BYTECODE = artifact.bytecode;

export type Deployment = {
  network: string;
  chainId: number;
  address: string;
  deployBlock: number;
  deployTx: string;
  deployer: string;
  deployedAt: string;
};

export function deploymentFile(network = config.network) {
  return path.join(ROOT_DIR, "deployments", `${network}.json`);
}

export function readDeployment(): Deployment | null {
  if (config.contractAddress) {
    return {
      network: config.network,
      chainId: config.chainId,
      address: ethers.getAddress(config.contractAddress),
      deployBlock: 0,
      deployTx: "",
      deployer: "",
      deployedAt: "",
    };
  }
  const file = deploymentFile();
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

/** Converts decoded log args into JSON-friendly values (bytes32 ids back to "BIN-001"). */
function plain(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v)) {
    try {
      const s = ethers.decodeBytes32String(v);
      if (/^[A-Z]{3}-\d{3}$/.test(s)) return s;
    } catch {
      /* not a short string */
    }
  }
  if (Array.isArray(v)) return v.map(plain);
  return v;
}

/**
 * The only place that talks to MST. Uses the MST SDK's Client for providers
 * and signers, ethers.Interface for ABI encoding, and records every
 * transaction it sends (or observes, for BridgeKey-signed ones) in the
 * database with real status, block, fee and decoded events.
 */
export class Ledger {
  readonly reader: InstanceType<typeof Client>;
  readonly provider: ethers.JsonRpcProvider;
  readonly clients: Partial<Record<SignerKind, InstanceType<typeof Client>>> = {};
  readonly verifier: ethers.Wallet | null;
  readonly iface = new ethers.Interface(LEDGER_ABI);
  readonly contract: ethers.Contract;
  readonly deployment: Deployment;
  readonly domain: ethers.TypedDataDomain;

  private nonces = new Map<string, number>(); // by signer address: roles may share a key
  private queues = new Map<string, Promise<unknown>>();

  constructor(deployment: Deployment) {
    this.deployment = deployment;
    this.reader = new Client(config.rpcUrl);
    this.provider = this.reader.provider.ethersProvider;
    this.provider.pollingInterval = 1500;
    for (const kind of ["gateway", "officer", "admin"] as SignerKind[]) {
      const key = config.keys[kind];
      if (key) this.clients[kind] = new Client(config.rpcUrl, key);
    }
    this.verifier = config.keys.verifier ? new ethers.Wallet(config.keys.verifier) : null;
    this.contract = new ethers.Contract(deployment.address, LEDGER_ABI, this.provider);
    this.domain = { name: "WasteCollectionLedger", version: "1", chainId: config.chainId, verifyingContract: deployment.address };
  }

  get address() {
    return this.deployment.address;
  }

  signerAddress(kind: SignerKind): string | null {
    return this.clients[kind]?.signer?.address ?? null;
  }

  // ------------------------------------------------------------------ reads

  async chainStatus(requestId: number): Promise<ChainStatus> {
    const r = await this.contract.getRequest(requestId);
    return CHAIN_STATUS[Number(r.status)];
  }

  async balanceOf(address: string): Promise<bigint> {
    return this.reader.provider.getBalance(address);
  }

  async fundStatus() {
    const [balance, reserved, free, totalPaid] = await Promise.all([
      this.reader.provider.getBalance(this.address),
      this.contract.reserved() as Promise<bigint>,
      this.contract.freeFunds() as Promise<bigint>,
      this.contract.totalPaid() as Promise<bigint>,
    ]);
    return { balance, reserved, free, totalPaid };
  }

  async hasRole(role: "OFFICER_ROLE" | "GATEWAY_ROLE" | "VERIFIER_ROLE" | "DEFAULT_ADMIN_ROLE", address: string) {
    const id = role === "DEFAULT_ADMIN_ROLE" ? ethers.ZeroHash : ethers.id(role);
    return this.contract.hasRole(id, address) as Promise<boolean>;
  }

  // ----------------------------------------------------------- typed data

  async signTyped(wallet: ethers.Wallet | ethers.HDNodeWallet, type: keyof typeof TYPES, value: Record<string, unknown>) {
    return wallet.signTypedData(this.domain, { [type]: TYPES[type] }, value);
  }

  // ----------------------------------------------------------------- writes

  /**
   * Encodes, simulates (so a revert costs nothing and returns its reason),
   * signs through the MST SDK, broadcasts, records and waits for the receipt.
   */
  async send(
    kind: SignerKind,
    method: string,
    args: unknown[],
    meta: TxMeta,
    hooks: { onSubmitted?: (row: TxRow) => Promise<void> | void; value?: bigint } = {},
  ): Promise<{ row: TxRow; events: DecodedEvent[] }> {
    const client = this.clients[kind];
    if (!client?.signer) throw new ChainError(`No ${kind} key configured`, "missing key");
    const from = client.signer.address;
    const data = this.iface.encodeFunctionData(method, args);
    const value = hooks.value ?? 0n;

    publish("tx.progress", { stage: "signing", method, action: meta.action, requestId: meta.requestId ?? null, signer: kind });
    let reason = await this.preflight(from, data, value);
    let gasLimit: bigint | undefined;
    if (reason?.startsWith("BadTimestamp") && (await this.idleSeconds()) > 60) {
      // A chain that only produces blocks on demand simulates against an old
      // block.timestamp, so a fresh device report looks "from the future".
      // The transaction lands in a new block and the contract re-checks the
      // window there; estimateGas would hit the same stale context, hence the
      // explicit limit.
      reason = null;
      gasLimit = 1_200_000n;
    }
    if (reason) {
      publish("tx.progress", { stage: "rejected", method, action: meta.action, requestId: meta.requestId ?? null, reason });
      throw new ChainError(`${method} would be rejected by the contract: ${reason}`, reason, "refused");
    }

    const hash = await this.enqueue(kind, async () => {
      const nonce = await this.nextNonce(kind);
      try {
        return await client.signer!.sendTransaction({ to: this.address, data, value, nonce, ...(gasLimit ? { gasLimit } : {}) });
      } catch (err) {
        this.nonces.delete(from); // resync on next send
        throw new ChainError(`${method} failed to broadcast: ${this.decodeError(err)}`, this.decodeError(err));
      }
    });

    const row = await this.insertSubmitted(hash, method, from, kind, meta, value);
    await hooks.onSubmitted?.(row);
    return this.confirm(row);
  }

  /** Records and confirms a transaction signed elsewhere (BridgeKey in the browser). */
  async observe(hash: string, meta: TxMeta): Promise<{ row: TxRow; events: DecodedEvent[] }> {
    const existing = await one<TxRow>(`SELECT * FROM blockchain_transactions WHERE hash = $1`, [hash]);
    if (existing?.status === "CONFIRMED") return { row: existing, events: existing.events ?? [] };
    let tx: ethers.TransactionResponse | null = null;
    for (let i = 0; i < 20 && !tx; i++) {
      tx = await this.provider.getTransaction(hash);
      if (!tx) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!tx) throw new ChainError(`Transaction ${hash} not found on ${config.networkLabel}`, "not found");
    if (tx.to?.toLowerCase() !== this.address.toLowerCase()) throw new ChainError("Transaction is not addressed to the ledger", "wrong target");
    let method = "unknown";
    try {
      method = this.iface.parseTransaction({ data: tx.data, value: tx.value })?.name ?? "unknown";
    } catch {
      /* keep unknown */
    }
    const row = existing ?? (await this.insertSubmitted(hash, method, tx.from, "officer-bridgekey", meta, tx.value));
    return this.confirm(row);
  }

  private async insertSubmitted(hash: string, method: string, from: string, signer: string, meta: TxMeta, value: bigint) {
    const [row] = await q<TxRow>(
      `INSERT INTO blockchain_transactions
         (hash, action, method, request_id, bin_id, worker_id, from_address, to_address, wallet, value_wei, status, signer_kind, network, chain_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'SUBMITTED',$11,$12,$13)
       ON CONFLICT (hash) DO UPDATE SET action = EXCLUDED.action
       RETURNING *`,
      [
        hash,
        meta.action,
        method,
        meta.requestId ?? null,
        meta.binId ?? null,
        meta.workerId ?? null,
        from,
        this.address,
        meta.wallet ?? null,
        meta.valueWei != null ? meta.valueWei.toString() : value > 0n ? value.toString() : null,
        signer,
        config.networkLabel,
        config.chainId,
      ],
    );
    publish("tx", this.present(row));
    return row;
  }

  private async confirm(row: TxRow): Promise<{ row: TxRow; events: DecodedEvent[] }> {
    const receipt = await Promise.race([
      this.reader.provider.waitForTransaction(row.hash),
      new Promise<null>((r) => setTimeout(() => r(null), 180_000)),
    ]);
    if (!receipt) {
      // Still pending: the reconciler will pick it up; callers see SUBMITTED.
      throw new ChainError(`Transaction ${row.hash} not confirmed within 3 minutes`, "timeout");
    }
    const events = this.parseLogs(receipt.logs);
    const ok = receipt.status === 1;
    const [updated] = await q<TxRow>(
      `UPDATE blockchain_transactions
          SET status = $2, block_number = $3, gas_used = $4, effective_gas_price = $5, fee_wei = $6,
              events = $7, confirmed_at = now(), error = $8
        WHERE id = $1 RETURNING *`,
      [
        row.id,
        ok ? "CONFIRMED" : "FAILED",
        receipt.blockNumber,
        receipt.gasUsed.toString(),
        receipt.gasPrice.toString(),
        receipt.fee.toString(),
        JSON.stringify(events),
        ok ? null : "reverted on-chain",
      ],
    );
    publish("tx", this.present(updated));
    if (!ok) throw new ChainError(`Transaction ${row.hash} reverted on-chain`, "reverted");
    return { row: updated, events };
  }

  /** Re-checks transactions left in SUBMITTED (e.g. after a timeout or restart). */
  async reconcilePending() {
    const pending = await q<TxRow>(`SELECT * FROM blockchain_transactions WHERE status = 'SUBMITTED' AND created_at < now() - interval '20 seconds'`);
    const settled: { row: TxRow; events: DecodedEvent[] }[] = [];
    for (const row of pending) {
      const receipt = await this.provider.getTransactionReceipt(row.hash).catch(() => null);
      if (!receipt) continue;
      settled.push(await this.confirm(row).catch(() => ({ row, events: [] })));
    }
    return settled;
  }

  parseLogs(logs: readonly ethers.Log[]): DecodedEvent[] {
    const out: DecodedEvent[] = [];
    for (const log of logs) {
      if (log.address.toLowerCase() !== this.address.toLowerCase()) continue;
      try {
        const parsed = this.iface.parseLog(log);
        if (!parsed) continue;
        const args: Record<string, unknown> = {};
        parsed.fragment.inputs.forEach((input, i) => (args[input.name] = plain(parsed.args[i])));
        out.push({ name: parsed.name, args });
      } catch {
        /* not ours */
      }
    }
    return out;
  }

  async preflight(from: string, data: string, value = 0n): Promise<string | null> {
    try {
      await this.provider.call({ from, to: this.address, data, value });
      return null;
    } catch (err) {
      return this.decodeError(err);
    }
  }

  /** Seconds since the chain's latest block. */
  private async idleSeconds(): Promise<number> {
    try {
      const b = await this.provider.getBlock("latest");
      return b ? Date.now() / 1000 - b.timestamp : 0;
    } catch {
      return 0;
    }
  }

  decodeError(err: unknown): string {
    const e = err as any;
    const data: unknown = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
    if (typeof data === "string" && data.length >= 10) {
      try {
        const parsed = this.iface.parseError(data);
        if (parsed) {
          const args = parsed.args.map((a: unknown) => String(plain(a)));
          if (parsed.name === "WrongStatus") return `WrongStatus(request ${args[0]} is ${CHAIN_STATUS[Number(args[1])]})`;
          return `${parsed.name}(${args.join(", ")})`;
        }
      } catch {
        /* fall through */
      }
    }
    if (e?.revert?.name) return `${e.revert.name}(${(e.revert.args ?? []).map((a: unknown) => String(plain(a))).join(", ")})`;
    return e?.shortMessage ?? e?.reason ?? e?.message ?? String(err);
  }

  present(row: TxRow) {
    return { ...row, url: explorerTx(row.hash) };
  }

  private enqueue<T>(kind: SignerKind, fn: () => Promise<T>): Promise<T> {
    const addr = this.clients[kind]!.signer!.address;
    const prev = this.queues.get(addr) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(addr, next.catch(() => undefined));
    return next;
  }

  private async nextNonce(kind: SignerKind): Promise<number> {
    const address = this.clients[kind]!.signer!.address;
    const known = this.nonces.get(address);
    const chainPending = await this.provider.getTransactionCount(address, "pending");
    const n = known === undefined ? chainPending : Math.max(known, chainPending);
    this.nonces.set(address, n + 1);
    return n;
  }
}

/** Typed messages. Must match the typehashes in WasteCollectionLedger.sol. */
export const TYPES = {
  FullnessReport: [
    { name: "binId", type: "bytes32" },
    { name: "fillPct", type: "uint256" },
    { name: "distanceMm", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "timestamp", type: "uint256" },
    { name: "evidenceHash", type: "bytes32" },
  ],
  RfidScan: [
    { name: "requestId", type: "uint256" },
    { name: "binId", type: "bytes32" },
    { name: "tagHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "timestamp", type: "uint256" },
  ],
  CollectionEvidence: [
    { name: "requestId", type: "uint256" },
    { name: "binId", type: "bytes32" },
    { name: "fillBefore", type: "uint256" },
    { name: "fillAfter", type: "uint256" },
    { name: "lidOpenedAt", type: "uint256" },
    { name: "lidClosedAt", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "evidenceHash", type: "bytes32" },
  ],
  AiVerdict: [
    { name: "requestId", type: "uint256" },
    { name: "binId", type: "bytes32" },
    { name: "kind", type: "uint8" },
    { name: "verified", type: "bool" },
    { name: "confidenceBps", type: "uint256" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "reportHash", type: "bytes32" },
  ],
} satisfies Record<string, ethers.TypedDataField[]>;

export const idBytes = (id: string) => ethers.encodeBytes32String(id);

let instance: Ledger | null = null;
export function ledger(): Ledger {
  if (!instance) {
    const d = readDeployment();
    if (!d) throw new Error(`No ledger deployed on ${config.network}. Run \`npm run deploy\`.`);
    instance = new Ledger(d);
  }
  return instance;
}
export function ledgerReady(): boolean {
  return !!readDeployment();
}
