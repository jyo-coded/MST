import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HDNodeWallet, TypedDataDomain } from "ethers";
import type { CivicProofVault } from "../typechain-types";

const TYPES = {
  HireRequest: [
    { name: "binId", type: "uint256" },
    { name: "fillLevel", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
  AcceptJob: [
    { name: "jobId", type: "uint256" },
    { name: "collectorId", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
  ServiceEvidence: [
    { name: "jobId", type: "uint256" },
    { name: "binId", type: "uint256" },
    { name: "tagHash", type: "bytes32" },
    { name: "fillBefore", type: "uint256" },
    { name: "fillAfter", type: "uint256" },
    { name: "serviceStart", type: "uint256" },
    { name: "serviceEnd", type: "uint256" },
    { name: "rawDataHash", type: "bytes32" },
  ],
  CollectorClaim: [
    { name: "jobId", type: "uint256" },
    { name: "collectorId", type: "uint256" },
    { name: "hopperBefore", type: "uint256" },
    { name: "hopperAfter", type: "uint256" },
    { name: "rawDataHash", type: "bytes32" },
  ],
  GuardianApproval: [
    { name: "jobId", type: "uint256" },
    { name: "evidenceDigest", type: "bytes32" },
    { name: "claimDigest", type: "bytes32" },
    { name: "payout", type: "uint256" },
    { name: "confidence", type: "uint256" },
    { name: "reportHash", type: "bytes32" },
  ],
} as const;

const one = (t: keyof typeof TYPES) => ({ [t]: TYPES[t] as unknown as { name: string; type: string }[] });

const WARD = 12n;
const BIN = 7n;
const COLLECTOR = 1n;
const TAG = ethers.keccak256(ethers.toUtf8Bytes("A1B2C3D4"));
const RAW = ethers.keccak256(ethers.toUtf8Bytes("t,fill,lid\n1,85,0\n2,5,1"));

const POLICY = {
  basePayout: ethers.parseEther("0.01"),
  ratePerPoint: ethers.parseEther("0.001"),
  maxPayoutPerJob: ethers.parseEther("0.1"),
  dailyCap: ethers.parseEther("0.25"),
  serviceWindow: 900,
  minFillToHire: 75,
  minFillDelta: 25,
  minConfidence: 70,
};

async function deploy() {
  const [admin, relayer, treasury, payout, stranger] = await ethers.getSigners();
  const guardian = ethers.Wallet.createRandom();
  const binDevice = ethers.Wallet.createRandom();
  const collectorDevice = ethers.Wallet.createRandom();

  const Vault = await ethers.getContractFactory("CivicProofVault");
  const vault = (await Vault.deploy(admin.address, treasury.address)) as unknown as CivicProofVault;
  await vault.waitForDeployment();

  await vault.grantRole(await vault.OPERATOR_ROLE(), relayer.address);
  await vault.grantRole(await vault.GUARDIAN_ROLE(), guardian.address);
  await vault.configureWard(WARD, POLICY);
  await vault.registerBin(BIN, WARD, binDevice.address, true);
  await vault.registerCollector(COLLECTOR, collectorDevice.address, payout.address, TAG, true);
  await vault.fundWard(WARD, { value: ethers.parseEther("1") });

  const { chainId } = await ethers.provider.getNetwork();
  const domain: TypedDataDomain = {
    name: "CivicProof",
    version: "1",
    chainId,
    verifyingContract: await vault.getAddress(),
  };

  return { vault, admin, relayer, treasury, payout, stranger, guardian, binDevice, collectorDevice, domain };
}

type Ctx = Awaited<ReturnType<typeof deploy>>;

async function now() {
  return BigInt(await time.latest());
}

async function hire(ctx: Ctx, fill = 85n, nonce?: bigint) {
  const req = { binId: BIN, fillLevel: fill, nonce: nonce ?? (await now()), expiry: (await now()) + 600n };
  const sig = await ctx.binDevice.signTypedData(ctx.domain, one("HireRequest"), req);
  await ctx.vault.connect(ctx.relayer).openJob(req, sig);
  return await ctx.vault.jobCount();
}

async function accept(ctx: Ctx, jobId: bigint) {
  const acc = { jobId, collectorId: COLLECTOR, expiry: (await now()) + 600n };
  const sig = await ctx.collectorDevice.signTypedData(ctx.domain, one("AcceptJob"), acc);
  await ctx.vault.connect(ctx.relayer).acceptJob(acc, sig);
}

async function bundle(
  ctx: Ctx,
  jobId: bigint,
  opts: {
    fillBefore?: bigint;
    fillAfter?: bigint;
    tag?: string;
    hopperBefore?: bigint;
    hopperAfter?: bigint;
    confidence?: bigint;
    payoutOverride?: bigint;
    binSigner?: HDNodeWallet;
    guardianSigner?: HDNodeWallet;
  } = {},
) {
  const t = await now();
  const evidence = {
    jobId,
    binId: BIN,
    tagHash: opts.tag ?? TAG,
    fillBefore: opts.fillBefore ?? 85n,
    fillAfter: opts.fillAfter ?? 5n,
    serviceStart: t,
    serviceEnd: t + 20n,
    rawDataHash: RAW,
  };
  const claim = {
    jobId,
    collectorId: COLLECTOR,
    hopperBefore: opts.hopperBefore ?? 10n,
    hopperAfter: opts.hopperAfter ?? 40n,
    rawDataHash: RAW,
  };
  const binSig = await (opts.binSigner ?? ctx.binDevice).signTypedData(ctx.domain, one("ServiceEvidence"), evidence);
  const collectorSig = await ctx.collectorDevice.signTypedData(ctx.domain, one("CollectorClaim"), claim);
  const delta = evidence.fillBefore > evidence.fillAfter ? evidence.fillBefore - evidence.fillAfter : 0n;
  const payout = opts.payoutOverride ?? (await ctx.vault.quotePayout(WARD, delta));
  const approval = {
    jobId,
    evidenceDigest: ethers.TypedDataEncoder.hash(ctx.domain, one("ServiceEvidence"), evidence),
    claimDigest: ethers.TypedDataEncoder.hash(ctx.domain, one("CollectorClaim"), claim),
    payout,
    confidence: opts.confidence ?? 92n,
    reportHash: ethers.keccak256(ethers.toUtf8Bytes("report")),
  };
  const guardianSig = await (opts.guardianSigner ?? ctx.guardian).signTypedData(
    ctx.domain,
    one("GuardianApproval"),
    approval,
  );
  return { evidence, binSig, claim, collectorSig, approval, guardianSig };
}

describe("CivicProofVault", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await deploy();
  });

  it("matches the digests the firmware and backend compute off-chain", async () => {
    const b = await bundle(ctx, 1n);
    expect(await ctx.vault.hashServiceEvidence(b.evidence)).to.equal(b.approval.evidenceDigest);
    expect(await ctx.vault.hashCollectorClaim(b.claim)).to.equal(b.approval.claimDigest);
    expect(await ctx.vault.domainSeparator()).to.equal(ethers.TypedDataEncoder.hashDomain(ctx.domain));
  });

  it("hire -> accept -> settle pays the registered collector for verified work", async () => {
    const jobId = await hire(ctx);
    await accept(ctx, jobId);

    const ward = await ctx.vault.getWard(WARD);
    expect(ward.reserved).to.equal(POLICY.maxPayoutPerJob);

    const b = await bundle(ctx, jobId);
    const expected = POLICY.basePayout + POLICY.ratePerPoint * 80n; // 0.09
    // Any relayer can submit; the signatures, not msg.sender, authorise it.
    const tx = ctx.vault.connect(ctx.stranger).settle(b);
    await expect(tx)
      .to.emit(ctx.vault, "JobSettled")
      .withArgs(jobId, BIN, COLLECTOR, ctx.payout.address, expected, 80n, b.approval.evidenceDigest, 92n, b.approval.reportHash);
    await expect(tx).to.changeEtherBalance(ctx.payout, expected);

    const job = await ctx.vault.getJob(jobId);
    expect(job.status).to.equal(3n); // Settled
    const after = await ctx.vault.getWard(WARD);
    expect(after.reserved).to.equal(0n);
    expect(after.balance).to.equal(ethers.parseEther("1") - expected);
    expect((await ctx.vault.getBin(BIN)).activeJobId).to.equal(0n);
    expect((await ctx.vault.getCollector(COLLECTOR)).completedJobs).to.equal(1n);
  });

  it("pays pro-rata for an interrupted service and caps at maxPayoutPerJob", async () => {
    const jobId = await hire(ctx);
    await accept(ctx, jobId);
    const b = await bundle(ctx, jobId, { fillBefore: 85n, fillAfter: 55n });
    const expected = POLICY.basePayout + POLICY.ratePerPoint * 30n;
    await expect(ctx.vault.settle(b)).to.changeEtherBalance(ctx.payout, expected);

    // 100 points would be 0.01 + 0.1 = 0.11, above the 0.1 per-job cap.
    expect(await ctx.vault.quotePayout(WARD, 100n)).to.equal(POLICY.maxPayoutPerJob);
  });

  it("rejects a hire request that is not signed by the bin", async () => {
    const req = { binId: BIN, fillLevel: 90n, nonce: 1n, expiry: (await now()) + 600n };
    const sig = await ctx.collectorDevice.signTypedData(ctx.domain, one("HireRequest"), req);
    await expect(ctx.vault.openJob(req, sig)).to.be.revertedWithCustomError(ctx.vault, "BadSignature");
  });

  it("rejects replayed hire nonces and a bin that is not full enough", async () => {
    await hire(ctx, 85n, 100n);
    await ctx.vault.connect(ctx.relayer).rejectJob(1n, 1, ethers.ZeroHash);
    const req = { binId: BIN, fillLevel: 85n, nonce: 100n, expiry: (await now()) + 600n };
    const sig = await ctx.binDevice.signTypedData(ctx.domain, one("HireRequest"), req);
    await expect(ctx.vault.openJob(req, sig)).to.be.revertedWithCustomError(ctx.vault, "StaleNonce");

    const low = { ...req, nonce: 101n, fillLevel: 40n };
    const lowSig = await ctx.binDevice.signTypedData(ctx.domain, one("HireRequest"), low);
    await expect(ctx.vault.openJob(low, lowSig)).to.be.revertedWithCustomError(ctx.vault, "NotFullEnough");
  });

  it("blocks a ghost pickup: bin level did not drop", async () => {
    const jobId = await hire(ctx);
    await accept(ctx, jobId);
    const b = await bundle(ctx, jobId, { fillBefore: 85n, fillAfter: 84n });
    await expect(ctx.vault.settle(b)).to.be.revertedWithCustomError(ctx.vault, "InsufficientWork");
  });

  it("blocks a collector whose RFID tag does not match the assigned contractor", async () => {
    const jobId = await hire(ctx);
    await accept(ctx, jobId);
    const b = await bundle(ctx, jobId, { tag: ethers.keccak256(ethers.toUtf8Bytes("CLONED")) });
    await expect(ctx.vault.settle(b)).to.be.revertedWithCustomError(ctx.vault, "TagMismatch");
  });

  it("blocks evidence forged by anyone other than the bin", async () => {
    const jobId = await hire(ctx);
    await accept(ctx, jobId);
    const b = await bundle(ctx, jobId, { binSigner: ethers.Wallet.createRandom() });
    await expect(ctx.vault.settle(b)).to.be.revertedWithCustomError(ctx.vault, "BadSignature").withArgs("bin");
  });

  it("blocks when the collector hopper did not fill (waste never reached the truck)", async () => {
    const jobId = await hire(ctx);
    await accept(ctx, jobId);
    const b = await bundle(ctx, jobId, { hopperBefore: 40n, hopperAfter: 40n });
    await expect(ctx.vault.settle(b)).to.be.revertedWithCustomError(ctx.vault, "HopperDidNotFill");
  });

  it("blocks approvals from a non-guardian, low AI confidence, or an inflated payout", async () => {
    const jobId = await hire(ctx);
    await accept(ctx, jobId);

    const fake = await bundle(ctx, jobId, { guardianSigner: ethers.Wallet.createRandom() });
    await expect(ctx.vault.settle(fake)).to.be.revertedWithCustomError(ctx.vault, "BadSignature").withArgs("guardian");

    const low = await bundle(ctx, jobId, { confidence: 40n });
    await expect(ctx.vault.settle(low)).to.be.revertedWithCustomError(ctx.vault, "ConfidenceTooLow");

    const inflated = await bundle(ctx, jobId, { payoutOverride: ethers.parseEther("500") });
    await expect(ctx.vault.settle(inflated)).to.be.revertedWithCustomError(ctx.vault, "PayoutMismatch");
  });

  it("blocks replaying a settlement that already paid", async () => {
    const jobId = await hire(ctx);
    await accept(ctx, jobId);
    const b = await bundle(ctx, jobId);
    await ctx.vault.settle(b);
    await expect(ctx.vault.settle(b)).to.be.revertedWithCustomError(ctx.vault, "WrongJobStatus");
  });

  it("stops paying after the service window and releases the escrow", async () => {
    const jobId = await hire(ctx);
    await accept(ctx, jobId);
    const b = await bundle(ctx, jobId);
    await time.increase(POLICY.serviceWindow + 1);
    await expect(ctx.vault.settle(b)).to.be.revertedWithCustomError(ctx.vault, "DeadlinePassed");
    await expect(ctx.vault.expireJob(jobId)).to.emit(ctx.vault, "JobExpired");
    expect((await ctx.vault.getWard(WARD)).reserved).to.equal(0n);
  });

  it("enforces the ward daily cap", async () => {
    // 0.09 per full job, cap 0.25 -> the third job the same day is refused.
    for (let i = 0; i < 2; i++) {
      const jobId = await hire(ctx);
      await accept(ctx, jobId);
      await ctx.vault.settle(await bundle(ctx, jobId));
    }
    const jobId = await hire(ctx);
    await accept(ctx, jobId);
    await expect(ctx.vault.settle(await bundle(ctx, jobId))).to.be.revertedWithCustomError(
      ctx.vault,
      "DailyCapExceeded",
    );
  });

  it("emergency pause freezes the machine economy", async () => {
    const jobId = await hire(ctx);
    await accept(ctx, jobId);
    const b = await bundle(ctx, jobId);
    await ctx.vault.pause();
    await expect(ctx.vault.settle(b)).to.be.revertedWithCustomError(ctx.vault, "EnforcedPause");
    await ctx.vault.unpause();
    await expect(ctx.vault.settle(b)).to.emit(ctx.vault, "JobSettled");
  });

  it("only the operator can reject jobs or record incidents; rejection is public", async () => {
    const jobId = await hire(ctx);
    await accept(ctx, jobId);
    await expect(ctx.vault.connect(ctx.stranger).rejectJob(jobId, 2, ethers.ZeroHash)).to.be.reverted;
    await expect(ctx.vault.connect(ctx.relayer).rejectJob(jobId, 2, ethers.id("report")))
      .to.emit(ctx.vault, "JobRejected")
      .withArgs(jobId, COLLECTOR, 2, ethers.id("report"));
    expect((await ctx.vault.getCollector(COLLECTOR)).rejectedJobs).to.equal(1n);
    expect((await ctx.vault.getWard(WARD)).reserved).to.equal(0n);

    await expect(ctx.vault.connect(ctx.relayer).recordIncident(1, 0, ethers.id("attack")))
      .to.emit(ctx.vault, "IncidentRecorded")
      .withArgs(1n, 1, 0n, ethers.id("attack"));
  });

  it("withdrawals only go to the treasury and never touch reserved escrow", async () => {
    const jobId = await hire(ctx);
    await accept(ctx, jobId);
    await expect(ctx.vault.withdrawWard(WARD, ethers.parseEther("1"))).to.be.revertedWithCustomError(
      ctx.vault,
      "InsufficientBudget",
    );
    await expect(ctx.vault.withdrawWard(WARD, ethers.parseEther("0.5"))).to.changeEtherBalance(
      ctx.treasury,
      ethers.parseEther("0.5"),
    );
    await expect(ctx.vault.connect(ctx.stranger).withdrawWard(WARD, 1n)).to.be.reverted;
  });
});
