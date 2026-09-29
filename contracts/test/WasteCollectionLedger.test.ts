import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HDNodeWallet, TypedDataDomain } from "ethers";
import type { WasteCollectionLedger } from "../typechain-types";

const TYPES = {
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
};
type TypeName = keyof typeof TYPES;
const one = (t: TypeName) => ({ [t]: TYPES[t] });

const S = { None: 0n, Requested: 1n, Approved: 2n, Assigned: 3n, InProgress: 4n, AwaitingApproval: 5n, Investigation: 6n, CompletionApproved: 7n, Paid: 8n, Rejected: 9n };

const BIN = ethers.encodeBytes32String("BIN-001");
const WORKER = ethers.encodeBytes32String("WRK-001");
const OTHER_WORKER = ethers.encodeBytes32String("WRK-002");
const CARD = ethers.keccak256(ethers.toUtf8Bytes("A1B2C3D4"));
const OTHER_CARD = ethers.keccak256(ethers.toUtf8Bytes("DEADBEEF"));
const EVIDENCE = ethers.id("telemetry window");
const REPORT = ethers.id("ai report");
const PAY = ethers.parseEther("0.05");

const POLICY = {
  minFillPct: 80,
  minFillRemoved: 50,
  minConfidenceBps: 8000,
  maxClockSkew: 300,
  maxReportAge: 3600,
  maxPayout: ethers.parseEther("0.1"),
};

async function deploy() {
  const [admin, gateway, officer, workerWallet, otherWallet, stranger] = await ethers.getSigners();
  const verifier = ethers.Wallet.createRandom();
  const device = ethers.Wallet.createRandom();

  const Ledger = await ethers.getContractFactory("WasteCollectionLedger");
  const ledger = (await Ledger.deploy(admin.address, POLICY)) as unknown as WasteCollectionLedger;
  await ledger.waitForDeployment();

  await ledger.grantRole(await ledger.GATEWAY_ROLE(), gateway.address);
  await ledger.grantRole(await ledger.OFFICER_ROLE(), officer.address);
  await ledger.grantRole(await ledger.VERIFIER_ROLE(), verifier.address);
  await ledger.registerBins([{ id: BIN, device: device.address, latE6: 22719600, lngE6: 75857700, active: true }]);
  await ledger.registerWorkers([
    { id: WORKER, wallet: workerWallet.address, rfidHash: CARD, active: true },
    { id: OTHER_WORKER, wallet: otherWallet.address, rfidHash: OTHER_CARD, active: true },
  ]);
  await ledger.fund({ value: ethers.parseEther("1") });

  const { chainId } = await ethers.provider.getNetwork();
  const domain: TypedDataDomain = {
    name: "WasteCollectionLedger",
    version: "1",
    chainId,
    verifyingContract: await ledger.getAddress(),
  };
  return { ledger, admin, gateway, officer, workerWallet, otherWallet, stranger, verifier, device, domain };
}
type Ctx = Awaited<ReturnType<typeof deploy>>;

let nonce = 1n;
const now = async () => BigInt(await time.latest());
const sign = (w: HDNodeWallet, ctx: Ctx, t: TypeName, v: Record<string, unknown>) => w.signTypedData(ctx.domain, one(t), v);

async function verdict(ctx: Ctx, requestId: bigint, kind: 1 | 2, verified = true, confidenceBps = 9680n, signer?: HDNodeWallet) {
  const v = { requestId, binId: BIN, kind, verified, confidenceBps, evidenceHash: EVIDENCE, reportHash: REPORT };
  return { v, sig: await sign(signer ?? ctx.verifier, ctx, "AiVerdict", v) };
}

async function create(ctx: Ctx, requestId = 1n, fillPct = 94n) {
  const r = { binId: BIN, fillPct, distanceMm: 62n, nonce: nonce++, timestamp: await now(), evidenceHash: EVIDENCE };
  const binSig = await sign(ctx.device, ctx, "FullnessReport", r);
  const { v, sig } = await verdict(ctx, requestId, 1);
  return ctx.ledger.connect(ctx.gateway).createRequest(requestId, r, binSig, v, sig);
}

async function toAssigned(ctx: Ctx, requestId = 1n) {
  await create(ctx, requestId);
  await ctx.ledger.connect(ctx.officer).approveRequest(requestId);
  await ctx.ledger.connect(ctx.officer).assignWorker(requestId, WORKER, PAY);
}

async function rfid(ctx: Ctx, requestId: bigint, tag = CARD) {
  const s = { requestId, binId: BIN, tagHash: tag, nonce: nonce++, timestamp: await now() };
  return ctx.ledger.connect(ctx.gateway).recordRfid(s, await sign(ctx.device, ctx, "RfidScan", s));
}

async function complete(ctx: Ctx, requestId: bigint, before = 94n, after = 17n, aiVerified = true, conf = 9820n) {
  const t = await now();
  const e = { requestId, binId: BIN, fillBefore: before, fillAfter: after, lidOpenedAt: t, lidClosedAt: t + 30n, nonce: nonce++, evidenceHash: EVIDENCE };
  const binSig = await sign(ctx.device, ctx, "CollectionEvidence", e);
  const { v, sig } = await verdict(ctx, requestId, 2, aiVerified, conf);
  return ctx.ledger.connect(ctx.gateway).submitCompletion(e, binSig, v, sig);
}

describe("WasteCollectionLedger", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await deploy();
  });

  it("off-chain digests match the contract (firmware / gateway compatibility)", async () => {
    const r = { binId: BIN, fillPct: 94n, distanceMm: 62n, nonce: 1n, timestamp: 1n, evidenceHash: EVIDENCE };
    expect(await ctx.ledger.hashFullnessReport(r)).to.equal(ethers.TypedDataEncoder.hash(ctx.domain, one("FullnessReport"), r));
    expect(await ctx.ledger.domainSeparator()).to.equal(ethers.TypedDataEncoder.hashDomain(ctx.domain));
  });

  it("runs the full lifecycle and pays the registered worker wallet", async () => {
    await expect(create(ctx, 7n)).to.emit(ctx.ledger, "RequestCreated").withArgs(7n, BIN, 94n, 9680n, EVIDENCE, REPORT);
    expect((await ctx.ledger.getBin(BIN)).activeRequest).to.equal(7n);

    await expect(ctx.ledger.connect(ctx.officer).approveRequest(7n)).to.emit(ctx.ledger, "RequestApproved").withArgs(7n, ctx.officer.address);
    await expect(ctx.ledger.connect(ctx.officer).assignWorker(7n, WORKER, PAY))
      .to.emit(ctx.ledger, "WorkerAssigned")
      .withArgs(7n, WORKER, ctx.workerWallet.address, PAY, ctx.officer.address);
    expect(await ctx.ledger.reserved()).to.equal(PAY);

    await expect(rfid(ctx, 7n)).to.emit(ctx.ledger, "RfidVerified").withArgs(7n, WORKER, CARD);
    expect((await ctx.ledger.getRequest(7n)).status).to.equal(S.InProgress);

    await expect(complete(ctx, 7n)).to.emit(ctx.ledger, "CollectionCompleted").withArgs(7n, 94n, 17n, 9820n, true, EVIDENCE, REPORT);
    expect((await ctx.ledger.getRequest(7n)).status).to.equal(S.AwaitingApproval);

    await ctx.ledger.connect(ctx.officer).approveCompletion(7n, ethers.id("looks good"));
    const tx = ctx.ledger.connect(ctx.officer).releasePayment(7n);
    await expect(tx).to.emit(ctx.ledger, "PaymentReleased").withArgs(7n, WORKER, ctx.workerWallet.address, PAY, ctx.officer.address);
    await expect(tx).to.changeEtherBalance(ctx.workerWallet, PAY);

    const q = await ctx.ledger.getRequest(7n);
    expect(q.status).to.equal(S.Paid);
    expect(await ctx.ledger.reserved()).to.equal(0n);
    expect(await ctx.ledger.totalPaid()).to.equal(PAY);
    expect((await ctx.ledger.getWorker(WORKER)).completed).to.equal(1n);
    expect((await ctx.ledger.getBin(BIN)).activeRequest).to.equal(0n);
  });

  describe("collection request", () => {
    it("only the gateway can create requests", async () => {
      const r = { binId: BIN, fillPct: 94n, distanceMm: 62n, nonce: nonce++, timestamp: await now(), evidenceHash: EVIDENCE };
      const binSig = await sign(ctx.device, ctx, "FullnessReport", r);
      const { v, sig } = await verdict(ctx, 1n, 1);
      await expect(ctx.ledger.connect(ctx.stranger).createRequest(1n, r, binSig, v, sig)).to.be.revertedWithCustomError(
        ctx.ledger,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("refuses a fullness report not signed by the bin", async () => {
      const r = { binId: BIN, fillPct: 94n, distanceMm: 62n, nonce: nonce++, timestamp: await now(), evidenceHash: EVIDENCE };
      const forged = await sign(ethers.Wallet.createRandom(), ctx, "FullnessReport", r);
      const { v, sig } = await verdict(ctx, 1n, 1);
      await expect(ctx.ledger.connect(ctx.gateway).createRequest(1n, r, forged, v, sig))
        .to.be.revertedWithCustomError(ctx.ledger, "BadSignature")
        .withArgs("bin");
    });

    it("refuses an AI verdict not signed by the verifier, or about other evidence", async () => {
      const r = { binId: BIN, fillPct: 94n, distanceMm: 62n, nonce: nonce++, timestamp: await now(), evidenceHash: EVIDENCE };
      const binSig = await sign(ctx.device, ctx, "FullnessReport", r);
      const fake = await verdict(ctx, 1n, 1, true, 9900n, ethers.Wallet.createRandom());
      await expect(ctx.ledger.connect(ctx.gateway).createRequest(1n, r, binSig, fake.v, fake.sig))
        .to.be.revertedWithCustomError(ctx.ledger, "BadSignature")
        .withArgs("verifier");

      const other = { ...fake.v, evidenceHash: ethers.id("other window") };
      const otherSig = await sign(ctx.verifier, ctx, "AiVerdict", other);
      await expect(ctx.ledger.connect(ctx.gateway).createRequest(1n, r, binSig, other, otherSig))
        .to.be.revertedWithCustomError(ctx.ledger, "VerdictMismatch")
        .withArgs("evidenceHash");
    });

    it("refuses low AI confidence, a negative verdict, and a bin that is not full", async () => {
      const r = { binId: BIN, fillPct: 94n, distanceMm: 62n, nonce: nonce++, timestamp: await now(), evidenceHash: EVIDENCE };
      const binSig = await sign(ctx.device, ctx, "FullnessReport", r);
      const low = await verdict(ctx, 1n, 1, true, 6000n);
      await expect(ctx.ledger.connect(ctx.gateway).createRequest(1n, r, binSig, low.v, low.sig)).to.be.revertedWithCustomError(
        ctx.ledger,
        "ConfidenceTooLow",
      );
      const no = await verdict(ctx, 1n, 1, false, 9000n);
      await expect(ctx.ledger.connect(ctx.gateway).createRequest(1n, r, binSig, no.v, no.sig)).to.be.revertedWithCustomError(
        ctx.ledger,
        "VerdictRejected",
      );
      await expect(create(ctx, 1n, 60n)).to.be.revertedWithCustomError(ctx.ledger, "NotFullEnough");
    });

    it("refuses replayed reports and a second request for a busy bin", async () => {
      const r = { binId: BIN, fillPct: 94n, distanceMm: 62n, nonce: nonce++, timestamp: await now(), evidenceHash: EVIDENCE };
      const binSig = await sign(ctx.device, ctx, "FullnessReport", r);
      const a = await verdict(ctx, 1n, 1);
      await ctx.ledger.connect(ctx.gateway).createRequest(1n, r, binSig, a.v, a.sig);
      await expect(create(ctx, 2n)).to.be.revertedWithCustomError(ctx.ledger, "BinBusy");

      await ctx.ledger.connect(ctx.officer).rejectRequest(1n, ethers.id("duplicate"));
      const b = await verdict(ctx, 2n, 1);
      await expect(ctx.ledger.connect(ctx.gateway).createRequest(2n, r, binSig, b.v, b.sig)).to.be.revertedWithCustomError(
        ctx.ledger,
        "StaleNonce",
      );
    });

    it("refuses stale device reports", async () => {
      const r = { binId: BIN, fillPct: 94n, distanceMm: 62n, nonce: nonce++, timestamp: (await now()) - 7200n, evidenceHash: EVIDENCE };
      const binSig = await sign(ctx.device, ctx, "FullnessReport", r);
      const { v, sig } = await verdict(ctx, 1n, 1);
      await expect(ctx.ledger.connect(ctx.gateway).createRequest(1n, r, binSig, v, sig)).to.be.revertedWithCustomError(ctx.ledger, "BadTimestamp");
    });
  });

  describe("assignment", () => {
    it("requires municipal approval first, an officer, and escrows the payment", async () => {
      await create(ctx, 1n);
      await expect(ctx.ledger.connect(ctx.officer).assignWorker(1n, WORKER, PAY)).to.be.revertedWithCustomError(ctx.ledger, "WrongStatus");
      await expect(ctx.ledger.connect(ctx.stranger).approveRequest(1n)).to.be.revertedWithCustomError(
        ctx.ledger,
        "AccessControlUnauthorizedAccount",
      );
      await ctx.ledger.connect(ctx.officer).approveRequest(1n);
      await expect(ctx.ledger.connect(ctx.officer).assignWorker(1n, WORKER, ethers.parseEther("5"))).to.be.revertedWithCustomError(
        ctx.ledger,
        "AmountOutOfRange",
      );
      await ctx.ledger.connect(ctx.officer).assignWorker(1n, WORKER, PAY);
      expect(await ctx.ledger.freeFunds()).to.equal(ethers.parseEther("1") - PAY);
    });

    it("a no-show assignment can be cancelled and the escrow released", async () => {
      await toAssigned(ctx, 1n);
      await expect(ctx.ledger.connect(ctx.officer).cancelAssignment(1n, ethers.id("no show"))).to.emit(ctx.ledger, "AssignmentCancelled");
      expect((await ctx.ledger.getRequest(1n)).status).to.equal(S.Approved);
      expect(await ctx.ledger.reserved()).to.equal(0n);
    });

    it("cannot escrow more than the fund holds", async () => {
      await ctx.ledger.withdraw(ethers.parseEther("0.99"), ctx.admin.address);
      await create(ctx, 1n);
      await ctx.ledger.connect(ctx.officer).approveRequest(1n);
      await expect(ctx.ledger.connect(ctx.officer).assignWorker(1n, WORKER, PAY)).to.be.revertedWithCustomError(ctx.ledger, "InsufficientFunds");
    });
  });

  describe("RFID", () => {
    it("records a mismatch publicly without unlocking, then accepts the assigned card", async () => {
      await toAssigned(ctx, 1n);
      await expect(rfid(ctx, 1n, OTHER_CARD)).to.emit(ctx.ledger, "RfidMismatch").withArgs(1n, BIN, OTHER_CARD, WORKER);
      expect((await ctx.ledger.getRequest(1n)).status).to.equal(S.Assigned);
      await expect(rfid(ctx, 1n)).to.emit(ctx.ledger, "RfidVerified");
      expect((await ctx.ledger.getRequest(1n)).status).to.equal(S.InProgress);
    });

    it("refuses an RFID scan not signed by the bin", async () => {
      await toAssigned(ctx, 1n);
      const s = { requestId: 1n, binId: BIN, tagHash: CARD, nonce: nonce++, timestamp: await now() };
      const forged = await sign(ethers.Wallet.createRandom(), ctx, "RfidScan", s);
      await expect(ctx.ledger.connect(ctx.gateway).recordRfid(s, forged)).to.be.revertedWithCustomError(ctx.ledger, "BadSignature");
    });
  });

  describe("completion", () => {
    it("cannot be marked complete without device evidence (no UI shortcut)", async () => {
      await toAssigned(ctx, 1n);
      await expect(ctx.ledger.connect(ctx.officer).approveCompletion(1n, ethers.ZeroHash)).to.be.revertedWithCustomError(ctx.ledger, "WrongStatus");
      await rfid(ctx, 1n);
      await expect(ctx.ledger.connect(ctx.officer).approveCompletion(1n, ethers.ZeroHash)).to.be.revertedWithCustomError(ctx.ledger, "WrongStatus");
      await expect(ctx.ledger.connect(ctx.officer).releasePayment(1n)).to.be.revertedWithCustomError(ctx.ledger, "WrongStatus");
    });

    it("sends an incomplete collection to investigation, where physics cannot be overruled", async () => {
      await toAssigned(ctx, 1n);
      await rfid(ctx, 1n);
      await expect(complete(ctx, 1n, 94n, 71n)).to.emit(ctx.ledger, "CollectionCompleted").withArgs(1n, 94n, 71n, 9820n, false, EVIDENCE, REPORT);
      expect((await ctx.ledger.getRequest(1n)).status).to.equal(S.Investigation);
      await expect(ctx.ledger.connect(ctx.officer).approveCompletion(1n, ethers.ZeroHash)).to.be.revertedWithCustomError(
        ctx.ledger,
        "InsufficientRemoval",
      );
      await expect(ctx.ledger.connect(ctx.officer).rejectCompletion(1n, ethers.id("not emptied"))).to.emit(ctx.ledger, "CompletionRejected");
      expect(await ctx.ledger.reserved()).to.equal(0n);
      expect((await ctx.ledger.getWorker(WORKER)).rejected).to.equal(1n);
      expect((await ctx.ledger.getBin(BIN)).activeRequest).to.equal(0n);
    });

    it("lets an officer overrule the AI's doubt after investigating, when the physics hold", async () => {
      await toAssigned(ctx, 1n);
      await rfid(ctx, 1n);
      await complete(ctx, 1n, 94n, 12n, false, 5500n);
      expect((await ctx.ledger.getRequest(1n)).status).to.equal(S.Investigation);
      await expect(ctx.ledger.connect(ctx.officer).approveCompletion(1n, ethers.id("inspected on site"))).to.emit(ctx.ledger, "CompletionApproved");
      await expect(ctx.ledger.connect(ctx.officer).releasePayment(1n)).to.changeEtherBalance(ctx.workerWallet, PAY);
    });

    it("officer can pull a verified collection into investigation", async () => {
      await toAssigned(ctx, 1n);
      await rfid(ctx, 1n);
      await complete(ctx, 1n);
      await expect(ctx.ledger.connect(ctx.officer).openInvestigation(1n, ethers.id("citizen complaint"))).to.emit(ctx.ledger, "InvestigationOpened");
      expect((await ctx.ledger.getRequest(1n)).status).to.equal(S.Investigation);
    });
  });

  describe("payment", () => {
    it("pays exactly once and only to the registered wallet", async () => {
      await toAssigned(ctx, 1n);
      await rfid(ctx, 1n);
      await complete(ctx, 1n);
      await ctx.ledger.connect(ctx.officer).approveCompletion(1n, ethers.ZeroHash);
      await expect(ctx.ledger.connect(ctx.stranger).releasePayment(1n)).to.be.revertedWithCustomError(
        ctx.ledger,
        "AccessControlUnauthorizedAccount",
      );
      await ctx.ledger.connect(ctx.officer).releasePayment(1n);
      await expect(ctx.ledger.connect(ctx.officer).releasePayment(1n)).to.be.revertedWithCustomError(ctx.ledger, "WrongStatus");
    });

    it("withdrawals cannot touch escrow, and pause freezes the workflow", async () => {
      await toAssigned(ctx, 1n);
      await expect(ctx.ledger.withdraw(ethers.parseEther("1"), ctx.admin.address)).to.be.revertedWithCustomError(ctx.ledger, "InsufficientFunds");
      await ctx.ledger.pause();
      await expect(rfid(ctx, 1n)).to.be.revertedWithCustomError(ctx.ledger, "EnforcedPause");
      await ctx.ledger.unpause();
      await expect(rfid(ctx, 1n)).to.emit(ctx.ledger, "RfidVerified");
    });

    it("anyone can top up the fund; incidents are logged by gateway or officer only", async () => {
      await expect(ctx.stranger.sendTransaction({ to: await ctx.ledger.getAddress(), value: 1000n })).to.emit(ctx.ledger, "Funded");
      await expect(ctx.ledger.connect(ctx.gateway).recordIncident(1, BIN, 0, ethers.id("obstruction"))).to.emit(ctx.ledger, "IncidentRecorded");
      await expect(ctx.ledger.connect(ctx.stranger).recordIncident(1, BIN, 0, ethers.id("x"))).to.be.revertedWithCustomError(
        ctx.ledger,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("stalled jobs (no stuck escrow, no stuck bin)", () => {
    const HOUR = 3600;

    it("an officer can abort an in-progress job: escrow is freed and the job returns to the queue", async () => {
      await toAssigned(ctx, 1n);
      await rfid(ctx, 1n);
      expect(await ctx.ledger.reserved()).to.equal(PAY);
      await expect(ctx.ledger.connect(ctx.officer).abortCollection(1n, ethers.id("worker left")))
        .to.emit(ctx.ledger, "CollectionAborted")
        .withArgs(1n, WORKER, ctx.officer.address, false, ethers.id("worker left"));
      expect(await ctx.ledger.reserved()).to.equal(0n);
      const r = await ctx.ledger.getRequest(1n);
      expect(r.status).to.equal(S.Approved);
      expect(r.amount).to.equal(0n);
      expect((await ctx.ledger.getWorker(WORKER)).rejected).to.equal(1n);
      // and it can be assigned to someone else and paid normally
      await ctx.ledger.connect(ctx.officer).assignWorker(1n, OTHER_WORKER, PAY);
      expect((await ctx.ledger.getRequest(1n)).status).to.equal(S.Assigned);
    });

    it("only an officer can abort, and only while the job is in progress", async () => {
      await toAssigned(ctx, 1n);
      await expect(ctx.ledger.connect(ctx.officer).abortCollection(1n, ethers.ZeroHash)).to.be.revertedWithCustomError(ctx.ledger, "WrongStatus");
      await rfid(ctx, 1n);
      await expect(ctx.ledger.connect(ctx.stranger).abortCollection(1n, ethers.ZeroHash)).to.be.revertedWithCustomError(
        ctx.ledger,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("anyone can expire an in-progress job after the timeout, but not before", async () => {
      await toAssigned(ctx, 1n);
      await rfid(ctx, 1n);
      await time.increase(HOUR); // default timeout is 6 h
      await expect(ctx.ledger.connect(ctx.stranger).expireCollection(1n)).to.be.revertedWithCustomError(ctx.ledger, "TimeoutNotReached");
      await time.increase(6 * HOUR);
      await expect(ctx.ledger.connect(ctx.stranger).expireCollection(1n))
        .to.emit(ctx.ledger, "CollectionAborted")
        .withArgs(1n, WORKER, ctx.stranger.address, true, ethers.ZeroHash);
      expect(await ctx.ledger.reserved()).to.equal(0n);
      expect((await ctx.ledger.getRequest(1n)).status).to.equal(S.Approved);
    });

    it("a no-show assignment can also be expired permissionlessly", async () => {
      await toAssigned(ctx, 1n);
      await time.increase(7 * HOUR);
      await ctx.ledger.connect(ctx.stranger).expireCollection(1n);
      expect(await ctx.ledger.reserved()).to.equal(0n);
      expect((await ctx.ledger.getRequest(1n)).status).to.equal(S.Approved);
    });

    it("cannot expire a job that is not stalled (awaiting approval or paid)", async () => {
      await toAssigned(ctx, 1n);
      await rfid(ctx, 1n);
      await complete(ctx, 1n);
      await time.increase(30 * HOUR);
      await expect(ctx.ledger.expireCollection(1n)).to.be.revertedWithCustomError(ctx.ledger, "WrongStatus");
      await ctx.ledger.connect(ctx.officer).approveCompletion(1n, ethers.ZeroHash);
      await ctx.ledger.connect(ctx.officer).releasePayment(1n);
      await expect(ctx.ledger.expireCollection(1n)).to.be.revertedWithCustomError(ctx.ledger, "WrongStatus");
    });

    it("a worker who expired cannot be paid from the old escrow (funds stay conserved)", async () => {
      const before = await ethers.provider.getBalance(ctx.workerWallet.address);
      await toAssigned(ctx, 1n);
      await rfid(ctx, 1n);
      await time.increase(7 * HOUR);
      await ctx.ledger.expireCollection(1n);
      await expect(ctx.ledger.connect(ctx.officer).releasePayment(1n)).to.be.revertedWithCustomError(ctx.ledger, "WrongStatus");
      expect(await ethers.provider.getBalance(ctx.workerWallet.address)).to.equal(before);
      expect(await ctx.ledger.freeFunds()).to.equal(ethers.parseEther("1"));
    });

    it("the timeout is admin-tunable within sane bounds", async () => {
      await expect(ctx.ledger.setCollectionTimeout(60)).to.be.revertedWithCustomError(ctx.ledger, "TimeoutOutOfRange");
      await expect(ctx.ledger.connect(ctx.stranger).setCollectionTimeout(2 * HOUR)).to.be.revertedWithCustomError(
        ctx.ledger,
        "AccessControlUnauthorizedAccount",
      );
      await expect(ctx.ledger.setCollectionTimeout(2 * HOUR)).to.emit(ctx.ledger, "CollectionTimeoutUpdated").withArgs(2 * HOUR);
      expect(await ctx.ledger.collectionTimeout()).to.equal(2 * HOUR);
    });
  });
});
