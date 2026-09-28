// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title CivicProofVault
/// @notice Holds a city ward's service budget and pays registered contractors
/// only for public work that the city's own machines have physically verified.
///
/// Every state change that moves money is authorised by signatures from
/// machines, never by a single party:
///   - the smart bin (city asset) signs that it is full and hires a collector,
///   - the collector robot (contractor asset) signs that it accepts the job,
///   - the bin signs what its sensors measured during the service,
///   - the collector signs what its hopper measured,
///   - the Guardian signs that off-chain policy + AI verification passed.
///
/// The contract re-checks the hard rules itself (registered payee, RFID tag,
/// minimum verified work, per-job cap, daily cap, deadline, replay). There is
/// deliberately no function that sends funds to an arbitrary address: the only
/// payee is the collector's payout wallet registered by the city admin, and the
/// only other outflow is a withdrawal to the fixed treasury.
contract CivicProofVault is AccessControl, Pausable, ReentrancyGuard, EIP712 {
    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------

    /// Gateway / relayer: pays gas, relays machine signatures, records
    /// rejections and incidents. Cannot move funds on its own.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// Signs GuardianApproval after deterministic policy + AI verification.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ---------------------------------------------------------------------
    // EIP-712 typed messages signed by machines
    // ---------------------------------------------------------------------

    bytes32 public constant HIRE_TYPEHASH =
        keccak256("HireRequest(uint256 binId,uint256 fillLevel,uint256 nonce,uint256 expiry)");

    bytes32 public constant ACCEPT_TYPEHASH =
        keccak256("AcceptJob(uint256 jobId,uint256 collectorId,uint256 expiry)");

    bytes32 public constant EVIDENCE_TYPEHASH =
        keccak256(
            "ServiceEvidence(uint256 jobId,uint256 binId,bytes32 tagHash,uint256 fillBefore,uint256 fillAfter,uint256 serviceStart,uint256 serviceEnd,bytes32 rawDataHash)"
        );

    bytes32 public constant CLAIM_TYPEHASH =
        keccak256(
            "CollectorClaim(uint256 jobId,uint256 collectorId,uint256 hopperBefore,uint256 hopperAfter,bytes32 rawDataHash)"
        );

    bytes32 public constant APPROVAL_TYPEHASH =
        keccak256(
            "GuardianApproval(uint256 jobId,bytes32 evidenceDigest,bytes32 claimDigest,uint256 payout,uint256 confidence,bytes32 reportHash)"
        );

    struct HireRequest {
        uint256 binId;
        uint256 fillLevel; // percent, 0-100
        uint256 nonce; // strictly increasing per bin
        uint256 expiry; // unix seconds
    }

    struct AcceptJob {
        uint256 jobId;
        uint256 collectorId;
        uint256 expiry;
    }

    struct ServiceEvidence {
        uint256 jobId;
        uint256 binId;
        bytes32 tagHash; // keccak256 of the RFID UID the bin read
        uint256 fillBefore; // percent
        uint256 fillAfter; // percent
        uint256 serviceStart; // unix seconds (bin clock)
        uint256 serviceEnd; // unix seconds (bin clock)
        bytes32 rawDataHash; // keccak256 of the raw sensor log uploaded off-chain
    }

    struct CollectorClaim {
        uint256 jobId;
        uint256 collectorId;
        uint256 hopperBefore; // percent
        uint256 hopperAfter; // percent
        bytes32 rawDataHash;
    }

    struct GuardianApproval {
        uint256 jobId;
        bytes32 evidenceDigest;
        bytes32 claimDigest;
        uint256 payout;
        uint256 confidence; // 0-100: AI verifier confidence, or 100 when a named human reviewer signs off
        bytes32 reportHash; // keccak256 of the full verification report (AI output, rule results, reviewer)
    }

    /// Everything settle() needs, bundled so the call stays one argument.
    struct Settlement {
        ServiceEvidence evidence;
        bytes binSig;
        CollectorClaim claim;
        bytes collectorSig;
        GuardianApproval approval;
        bytes guardianSig;
    }

    // ---------------------------------------------------------------------
    // Registry + budget state
    // ---------------------------------------------------------------------

    enum JobStatus {
        None,
        Open,
        Accepted,
        Settled,
        Rejected,
        Expired
    }

    struct WardPolicy {
        uint256 basePayout; // wei paid for any verified service
        uint256 ratePerPoint; // wei per verified fill-percentage point removed
        uint256 maxPayoutPerJob; // hard cap per job (also the escrow reserved on accept)
        uint256 dailyCap; // hard cap per UTC day across the ward
        uint32 serviceWindow; // seconds a collector has after accepting
        uint8 minFillToHire; // a bin may only hire when at least this full
        uint8 minFillDelta; // minimum verified fill reduction to be paid at all
        uint8 minConfidence; // verification confidence the Guardian must attest to
    }

    struct Ward {
        WardPolicy policy;
        uint256 balance; // funds held for this ward
        uint256 reserved; // escrow locked for accepted jobs
        uint256 spentToday;
        uint64 dayStart;
        bool exists;
    }

    struct Bin {
        address device; // secp256k1 key held by the bin's ESP32
        uint256 wardId;
        uint256 activeJobId;
        uint256 lastNonce;
        bool active;
    }

    struct Collector {
        address device; // secp256k1 key held by the collector's ESP32
        address payable payout; // the ONLY address this contract ever pays
        bytes32 tagHash; // RFID tag carried by the collector vehicle
        bool active;
        uint32 completedJobs;
        uint32 rejectedJobs;
        uint256 totalEarned;
    }

    struct Job {
        uint256 binId;
        uint256 wardId;
        uint256 collectorId;
        uint256 fillAtHire;
        JobStatus status;
        uint64 openedAt;
        uint64 acceptedAt;
        uint64 deadline;
        uint256 reserved;
        uint256 payout;
        bytes32 evidenceDigest;
        bytes32 reportHash;
    }

    uint256 public constant CLOCK_SKEW = 300; // tolerated device clock drift, seconds

    address payable public treasury;
    uint256 public jobCount;
    uint256 public incidentCount;

    mapping(uint256 => Ward) private _wards;
    mapping(uint256 => Bin) private _bins;
    mapping(uint256 => Collector) private _collectors;
    mapping(uint256 => Job) private _jobs;

    // ---------------------------------------------------------------------
    // Events (what judges / auditors see on MSTScan)
    // ---------------------------------------------------------------------

    event TreasuryUpdated(address indexed treasury);
    event WardConfigured(uint256 indexed wardId, WardPolicy policy);
    event WardFunded(uint256 indexed wardId, address indexed from, uint256 amount);
    event WardWithdrawn(uint256 indexed wardId, address indexed treasury, uint256 amount);
    event BinRegistered(uint256 indexed binId, uint256 indexed wardId, address device, bool active);
    event CollectorRegistered(
        uint256 indexed collectorId,
        address device,
        address payout,
        bytes32 tagHash,
        bool active
    );
    event JobOpened(uint256 indexed jobId, uint256 indexed binId, uint256 indexed wardId, uint256 fillLevel);
    event JobAccepted(uint256 indexed jobId, uint256 indexed collectorId, uint256 deadline, uint256 reserved);
    event JobSettled(
        uint256 indexed jobId,
        uint256 indexed binId,
        uint256 indexed collectorId,
        address payout,
        uint256 amount,
        uint256 fillDelta,
        bytes32 evidenceDigest,
        uint256 confidence,
        bytes32 reportHash
    );
    event JobRejected(uint256 indexed jobId, uint256 indexed collectorId, uint8 reasonCode, bytes32 reportHash);
    event JobExpired(uint256 indexed jobId, uint256 indexed collectorId);
    event IncidentRecorded(
        uint256 indexed incidentId,
        uint8 indexed kind,
        uint256 indexed relatedJobId,
        bytes32 detailsHash
    );

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error UnknownWard(uint256 wardId);
    error UnknownBin(uint256 binId);
    error UnknownCollector(uint256 collectorId);
    error InactiveBin(uint256 binId);
    error InactiveCollector(uint256 collectorId);
    error ZeroAddress();
    error BadSignature(string who);
    error SignatureExpired();
    error StaleNonce(uint256 got, uint256 last);
    error BinBusy(uint256 activeJobId);
    error NotFullEnough(uint256 fill, uint256 required);
    error WrongJobStatus(uint256 jobId, JobStatus status);
    error DeadlinePassed(uint256 jobId);
    error DeadlineNotPassed(uint256 jobId);
    error Mismatch(string field);
    error TagMismatch();
    error InsufficientWork(uint256 delta, uint256 required);
    error HopperDidNotFill();
    error BadServiceTiming();
    error ConfidenceTooLow(uint256 got, uint256 required);
    error PayoutMismatch(uint256 approved, uint256 computed);
    error InsufficientBudget(uint256 available, uint256 required);
    error DailyCapExceeded(uint256 spent, uint256 cap);
    error TransferFailed();

    constructor(address admin, address payable treasury_) EIP712("CivicProof", "1") {
        if (admin == address(0) || treasury_ == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    // =====================================================================
    // City admin: registry, policy, budget
    // =====================================================================

    function setTreasury(address payable treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function configureWard(uint256 wardId, WardPolicy calldata policy) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Ward storage w = _wards[wardId];
        w.policy = policy;
        w.exists = true;
        emit WardConfigured(wardId, policy);
    }

    function registerBin(uint256 binId, uint256 wardId, address device, bool active)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (!_wards[wardId].exists) revert UnknownWard(wardId);
        if (device == address(0)) revert ZeroAddress();
        Bin storage b = _bins[binId];
        b.device = device;
        b.wardId = wardId;
        b.active = active;
        emit BinRegistered(binId, wardId, device, active);
    }

    function registerCollector(
        uint256 collectorId,
        address device,
        address payable payout,
        bytes32 tagHash,
        bool active
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (device == address(0) || payout == address(0)) revert ZeroAddress();
        Collector storage c = _collectors[collectorId];
        c.device = device;
        c.payout = payout;
        c.tagHash = tagHash;
        c.active = active;
        emit CollectorRegistered(collectorId, device, payout, tagHash, active);
    }

    /// @notice Anyone (city treasury, state grant, CSR donor) can top up a ward.
    function fundWard(uint256 wardId) external payable {
        if (!_wards[wardId].exists) revert UnknownWard(wardId);
        _wards[wardId].balance += msg.value;
        emit WardFunded(wardId, msg.sender, msg.value);
    }

    /// @notice Unreserved budget can only ever go back to the fixed treasury.
    function withdrawWard(uint256 wardId, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        Ward storage w = _wards[wardId];
        if (!w.exists) revert UnknownWard(wardId);
        uint256 free = w.balance - w.reserved;
        if (amount > free) revert InsufficientBudget(free, amount);
        w.balance -= amount;
        (bool ok, ) = treasury.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit WardWithdrawn(wardId, treasury, amount);
    }

    /// @notice Emergency stop. Also wired to a physical supervisor RFID card.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // =====================================================================
    // Machine economy: hire -> accept -> settle / reject / expire
    // =====================================================================

    /// @notice The bin hires a collector. Only a signature from the bin's own
    /// device key can open a job, so a job cannot be invented off-chain.
    /// Anyone may relay it (the relayer is untrusted and only pays gas).
    function openJob(HireRequest calldata req, bytes calldata binSig)
        external
        whenNotPaused
        returns (uint256 jobId)
    {
        Bin storage b = _bins[req.binId];
        if (b.device == address(0)) revert UnknownBin(req.binId);
        if (!b.active) revert InactiveBin(req.binId);
        if (block.timestamp > req.expiry) revert SignatureExpired();
        if (req.nonce <= b.lastNonce) revert StaleNonce(req.nonce, b.lastNonce);
        if (b.activeJobId != 0) revert BinBusy(b.activeJobId);

        Ward storage w = _wards[b.wardId];
        if (req.fillLevel < w.policy.minFillToHire) revert NotFullEnough(req.fillLevel, w.policy.minFillToHire);

        _requireSigner(hashHireRequest(req), binSig, b.device, "bin");

        b.lastNonce = req.nonce;
        jobId = ++jobCount;
        b.activeJobId = jobId;

        Job storage j = _jobs[jobId];
        j.binId = req.binId;
        j.wardId = b.wardId;
        j.fillAtHire = req.fillLevel;
        j.status = JobStatus.Open;
        j.openedAt = uint64(block.timestamp);

        emit JobOpened(jobId, req.binId, b.wardId, req.fillLevel);
    }

    /// @notice A collector robot accepts an open job. The ward's max payout is
    /// reserved as escrow, so the contractor knows the money exists before
    /// doing the work.
    function acceptJob(AcceptJob calldata acc, bytes calldata collectorSig) external whenNotPaused {
        Job storage j = _jobs[acc.jobId];
        if (j.status != JobStatus.Open) revert WrongJobStatus(acc.jobId, j.status);
        if (block.timestamp > acc.expiry) revert SignatureExpired();

        Collector storage c = _collectors[acc.collectorId];
        if (c.device == address(0)) revert UnknownCollector(acc.collectorId);
        if (!c.active) revert InactiveCollector(acc.collectorId);

        _requireSigner(hashAcceptJob(acc), collectorSig, c.device, "collector");

        Ward storage w = _wards[j.wardId];
        uint256 escrow = w.policy.maxPayoutPerJob;
        uint256 free = w.balance - w.reserved;
        if (free < escrow) revert InsufficientBudget(free, escrow);
        w.reserved += escrow;

        j.collectorId = acc.collectorId;
        j.status = JobStatus.Accepted;
        j.acceptedAt = uint64(block.timestamp);
        j.deadline = uint64(block.timestamp + w.policy.serviceWindow);
        j.reserved = escrow;

        emit JobAccepted(acc.jobId, acc.collectorId, j.deadline, escrow);
    }

    /// @notice Pays the registered collector for physically verified work.
    /// The amount is computed here from the bin's signed measurements; the
    /// Guardian must have approved exactly that amount.
    function settle(Settlement calldata s) external whenNotPaused nonReentrant {
        uint256 jobId = s.evidence.jobId;
        Job storage j = _jobs[jobId];
        if (j.status != JobStatus.Accepted) revert WrongJobStatus(jobId, j.status);
        if (block.timestamp > j.deadline) revert DeadlinePassed(jobId);

        bytes32 evidenceDigest = _checkEvidence(j, s.evidence, s.binSig);
        bytes32 claimDigest = _checkClaim(jobId, j, s.claim, s.collectorSig);

        uint256 fillDelta = s.evidence.fillBefore - s.evidence.fillAfter;
        uint256 payout = quotePayout(j.wardId, fillDelta);
        _checkApproval(s, evidenceDigest, claimDigest, payout, j.wardId);
        _spend(_wards[j.wardId], j.reserved, payout);

        j.status = JobStatus.Settled;
        j.payout = payout;
        j.evidenceDigest = evidenceDigest;
        j.reportHash = s.approval.reportHash;
        _bins[j.binId].activeJobId = 0;

        _payCollector(jobId, j, payout, fillDelta, evidenceDigest, s.approval);
    }

    function _payCollector(
        uint256 jobId,
        Job storage j,
        uint256 payout,
        uint256 fillDelta,
        bytes32 evidenceDigest,
        GuardianApproval calldata ap
    ) internal {
        Collector storage c = _collectors[j.collectorId];
        c.completedJobs += 1;
        c.totalEarned += payout;

        (bool ok, ) = c.payout.call{value: payout}("");
        if (!ok) revert TransferFailed();

        emit JobSettled(
            jobId,
            j.binId,
            j.collectorId,
            c.payout,
            payout,
            fillDelta,
            evidenceDigest,
            ap.confidence,
            ap.reportHash
        );
    }

    /// @notice The Guardian refused the payment. The rejection and the hash of
    /// the verification report are public, so the contractor can dispute it.
    function rejectJob(uint256 jobId, uint8 reasonCode, bytes32 reportHash) external onlyRole(OPERATOR_ROLE) {
        Job storage j = _jobs[jobId];
        if (j.status != JobStatus.Open && j.status != JobStatus.Accepted) revert WrongJobStatus(jobId, j.status);
        if (j.status == JobStatus.Accepted) {
            _wards[j.wardId].reserved -= j.reserved;
            _collectors[j.collectorId].rejectedJobs += 1;
        }
        j.status = JobStatus.Rejected;
        j.reportHash = reportHash;
        _bins[j.binId].activeJobId = 0;
        emit JobRejected(jobId, j.collectorId, reasonCode, reportHash);
    }

    /// @notice After the service window closes nobody can be paid for the job.
    /// Anyone can call this to release the escrow and free the bin.
    function expireJob(uint256 jobId) external {
        Job storage j = _jobs[jobId];
        if (j.status != JobStatus.Accepted) revert WrongJobStatus(jobId, j.status);
        if (block.timestamp <= j.deadline) revert DeadlineNotPassed(jobId);
        _wards[j.wardId].reserved -= j.reserved;
        j.status = JobStatus.Expired;
        _bins[j.binId].activeJobId = 0;
        emit JobExpired(jobId, j.collectorId);
    }

    /// @notice Tamper-evident log of blocked attacks (unauthorised payment
    /// intents, sensor spoofing, replays). Moves no funds.
    function recordIncident(uint8 kind, uint256 relatedJobId, bytes32 detailsHash)
        external
        onlyRole(OPERATOR_ROLE)
        returns (uint256 incidentId)
    {
        incidentId = ++incidentCount;
        emit IncidentRecorded(incidentId, kind, relatedJobId, detailsHash);
    }

    // =====================================================================
    // Views
    // =====================================================================

    function quotePayout(uint256 wardId, uint256 fillDelta) public view returns (uint256) {
        WardPolicy storage p = _wards[wardId].policy;
        uint256 amount = p.basePayout + p.ratePerPoint * fillDelta;
        return amount > p.maxPayoutPerJob ? p.maxPayoutPerJob : amount;
    }

    function getWard(uint256 wardId) external view returns (Ward memory) {
        return _wards[wardId];
    }

    function getBin(uint256 binId) external view returns (Bin memory) {
        return _bins[binId];
    }

    function getCollector(uint256 collectorId) external view returns (Collector memory) {
        return _collectors[collectorId];
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // Digest helpers: the ESP32 firmware and the backend must produce exactly
    // these values. Static structs ABI-encode identically to their fields.

    function hashHireRequest(HireRequest calldata req) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(HIRE_TYPEHASH, req)));
    }

    function hashAcceptJob(AcceptJob calldata acc) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ACCEPT_TYPEHASH, acc)));
    }

    function hashServiceEvidence(ServiceEvidence calldata ev) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(EVIDENCE_TYPEHASH, ev)));
    }

    function hashCollectorClaim(CollectorClaim calldata cl) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, cl)));
    }

    function hashGuardianApproval(GuardianApproval calldata ap) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(APPROVAL_TYPEHASH, ap)));
    }

    // =====================================================================
    // Internal checks
    // =====================================================================

    function _checkEvidence(Job storage j, ServiceEvidence calldata ev, bytes calldata binSig)
        internal
        view
        returns (bytes32 digest)
    {
        if (ev.binId != j.binId) revert Mismatch("binId");
        if (ev.fillBefore > 100) revert Mismatch("fillBefore");
        if (ev.tagHash != _collectors[j.collectorId].tagHash) revert TagMismatch();
        if (ev.serviceEnd < ev.serviceStart) revert BadServiceTiming();
        if (ev.serviceStart + CLOCK_SKEW < j.acceptedAt) revert BadServiceTiming();
        if (ev.serviceEnd > block.timestamp + CLOCK_SKEW) revert BadServiceTiming();

        uint256 minDelta = _wards[j.wardId].policy.minFillDelta;
        if (ev.fillBefore < ev.fillAfter + minDelta) {
            revert InsufficientWork(ev.fillBefore > ev.fillAfter ? ev.fillBefore - ev.fillAfter : 0, minDelta);
        }

        digest = hashServiceEvidence(ev);
        _requireSigner(digest, binSig, _bins[j.binId].device, "bin");
    }

    function _checkClaim(uint256 jobId, Job storage j, CollectorClaim calldata cl, bytes calldata collectorSig)
        internal
        view
        returns (bytes32 digest)
    {
        if (cl.jobId != jobId) revert Mismatch("claim.jobId");
        if (cl.collectorId != j.collectorId) revert Mismatch("collectorId");
        if (cl.hopperAfter <= cl.hopperBefore) revert HopperDidNotFill();

        digest = hashCollectorClaim(cl);
        _requireSigner(digest, collectorSig, _collectors[j.collectorId].device, "collector");
    }

    function _checkApproval(
        Settlement calldata s,
        bytes32 evidenceDigest,
        bytes32 claimDigest,
        uint256 payout,
        uint256 wardId
    ) internal view {
        GuardianApproval calldata ap = s.approval;
        if (ap.jobId != s.evidence.jobId) revert Mismatch("approval.jobId");
        if (ap.evidenceDigest != evidenceDigest) revert Mismatch("evidenceDigest");
        if (ap.claimDigest != claimDigest) revert Mismatch("claimDigest");
        if (ap.payout != payout) revert PayoutMismatch(ap.payout, payout);
        uint256 minConf = _wards[wardId].policy.minConfidence;
        if (ap.confidence < minConf) revert ConfidenceTooLow(ap.confidence, minConf);

        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hashGuardianApproval(ap), s.guardianSig);
        if (err != ECDSA.RecoverError.NoError || !hasRole(GUARDIAN_ROLE, signer)) revert BadSignature("guardian");
    }

    function _spend(Ward storage w, uint256 reserved, uint256 payout) internal {
        uint64 today = uint64(block.timestamp - (block.timestamp % 1 days));
        if (w.dayStart != today) {
            w.dayStart = today;
            w.spentToday = 0;
        }
        if (w.spentToday + payout > w.policy.dailyCap) revert DailyCapExceeded(w.spentToday, w.policy.dailyCap);
        if (w.balance < payout) revert InsufficientBudget(w.balance, payout);

        w.spentToday += payout;
        w.reserved -= reserved;
        w.balance -= payout;
    }

    function _requireSigner(bytes32 digest, bytes calldata sig, address expected, string memory who) internal pure {
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError || signer != expected) revert BadSignature(who);
    }
}
