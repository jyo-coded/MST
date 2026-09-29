// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title WasteCollectionLedger
/// @notice The on-chain half of a municipal waste-collection workflow on MST.
///
/// High-frequency telemetry stays off-chain. This contract records the state
/// transitions that matter, and holds the municipal fund that pays workers:
///
///   BIN_REGISTERED -> COLLECTION_REQUEST_CREATED (bin-signed fullness + AI attestation)
///   -> MUNICIPAL_APPROVAL -> WORKER_ASSIGNED (payment escrowed)
///   -> RFID_VERIFIED / COLLECTION_STARTED (bin-signed RFID scan)
///   -> AI_COMPLETION_VERIFIED (bin-signed before/after evidence + AI attestation)
///   -> MUNICIPAL_COMPLETION_APPROVED -> PAYMENT_CONFIRMED
///
/// Trust model:
///  - a request can only be created from a report signed by the bin's device
///    key AND an AI verdict signed by the verifier key;
///  - a collection can only reach "awaiting approval" with bin-signed
///    before/after levels AND a positive AI verdict;
///  - an officer can override the AI's doubt, but never the physics: a
///    collection that did not remove enough waste cannot be approved;
///  - payment goes only to the worker wallet registered by the municipality,
///    for the amount escrowed at assignment. There is no arbitrary transfer.
contract WasteCollectionLedger is AccessControl, Pausable, ReentrancyGuard, EIP712 {
    // ------------------------------------------------------------------ roles

    /// Municipal officers: approve, assign, investigate, release payment.
    bytes32 public constant OFFICER_ROLE = keccak256("OFFICER_ROLE");
    /// IoT gateway: relays device-signed evidence from the bins.
    bytes32 public constant GATEWAY_ROLE = keccak256("GATEWAY_ROLE");
    /// Sensor-fusion / AI verification service: signs verdicts.
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");

    // --------------------------------------------------------- typed messages

    bytes32 public constant FULLNESS_TYPEHASH =
        keccak256(
            "FullnessReport(bytes32 binId,uint256 fillPct,uint256 distanceMm,uint256 nonce,uint256 timestamp,bytes32 evidenceHash)"
        );
    bytes32 public constant RFID_TYPEHASH =
        keccak256("RfidScan(uint256 requestId,bytes32 binId,bytes32 tagHash,uint256 nonce,uint256 timestamp)");
    bytes32 public constant COMPLETION_TYPEHASH =
        keccak256(
            "CollectionEvidence(uint256 requestId,bytes32 binId,uint256 fillBefore,uint256 fillAfter,uint256 lidOpenedAt,uint256 lidClosedAt,uint256 nonce,bytes32 evidenceHash)"
        );
    bytes32 public constant VERDICT_TYPEHASH =
        keccak256(
            "AiVerdict(uint256 requestId,bytes32 binId,uint8 kind,bool verified,uint256 confidenceBps,bytes32 evidenceHash,bytes32 reportHash)"
        );

    uint8 public constant VERDICT_FULLNESS = 1;
    uint8 public constant VERDICT_COMPLETION = 2;

    struct FullnessReport {
        bytes32 binId;
        uint256 fillPct; // 0-100
        uint256 distanceMm; // ultrasonic distance to the waste surface
        uint256 nonce; // strictly increasing per bin
        uint256 timestamp; // unix seconds, device clock
        bytes32 evidenceHash; // keccak256 of the telemetry window the AI analysed
    }

    struct RfidScan {
        uint256 requestId;
        bytes32 binId;
        bytes32 tagHash; // keccak256 of the card UID read by the bin
        uint256 nonce;
        uint256 timestamp;
    }

    struct CollectionEvidence {
        uint256 requestId;
        bytes32 binId;
        uint256 fillBefore; // 0-100
        uint256 fillAfter; // 0-100
        uint256 lidOpenedAt;
        uint256 lidClosedAt;
        uint256 nonce;
        bytes32 evidenceHash;
    }

    struct AiVerdict {
        uint256 requestId;
        bytes32 binId;
        uint8 kind; // 1 = fullness, 2 = completion
        bool verified;
        uint256 confidenceBps; // 0-10000 (9682 = 96.82 %)
        bytes32 evidenceHash; // must equal the device report's evidenceHash
        bytes32 reportHash; // keccak256 of the full verification report (inputs, checks, reasons)
    }

    // ------------------------------------------------------------------ state

    enum Status {
        None,
        Requested,
        Approved,
        Assigned,
        InProgress,
        AwaitingApproval,
        Investigation,
        CompletionApproved,
        Paid,
        Rejected
    }

    struct Policy {
        uint16 minFillPct; // bins may request collection at or above this level
        uint16 minFillRemoved; // points of fill that must be removed for a valid collection
        uint16 minConfidenceBps; // AI confidence floor
        uint32 maxClockSkew; // tolerated device clock drift into the future (s)
        uint32 maxReportAge; // device reports older than this are refused (s)
        uint256 maxPayout; // per-collection payment cap (wei)
    }

    struct Bin {
        address device;
        int32 latE6;
        int32 lngE6;
        bool active;
        uint256 activeRequest;
        uint256 lastNonce;
        uint32 collections;
    }

    struct Worker {
        address payable wallet;
        bytes32 rfidHash;
        bool active;
        uint32 completed;
        uint32 rejected;
        uint256 earned;
    }

    struct Request {
        bytes32 binId;
        Status status;
        bytes32 workerId;
        uint16 fillDetected;
        uint16 fillBefore;
        uint16 fillAfter;
        uint16 fullnessConfidenceBps;
        uint16 completionConfidenceBps;
        bool completionVerified;
        uint64 createdAt;
        uint64 approvedAt;
        uint64 assignedAt;
        uint64 startedAt;
        uint64 completedAt;
        uint64 paidAt;
        uint256 amount;
        bytes32 fullnessEvidence;
        bytes32 completionEvidence;
    }

    struct BinInput {
        bytes32 id;
        address device;
        int32 latE6;
        int32 lngE6;
        bool active;
    }

    struct WorkerInput {
        bytes32 id;
        address payable wallet;
        bytes32 rfidHash;
        bool active;
    }

    Policy public policy;
    uint256 public reserved; // escrow for assigned, unpaid collections
    uint256 public latestRequestId;
    uint256 public incidentCount;
    uint256 public totalPaid;
    /// Seconds an assigned or in-progress collection may sit idle before anyone
    /// can expire it and free the escrow. Admin-tunable; default 6 hours.
    uint32 public collectionTimeout = 6 hours;

    mapping(bytes32 => Bin) private _bins;
    mapping(bytes32 => Worker) private _workers;
    mapping(uint256 => Request) private _requests;

    // ----------------------------------------------------------------- events

    event PolicyUpdated(Policy policy);
    event Funded(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event BinRegistered(bytes32 indexed binId, address device, int32 latE6, int32 lngE6, bool active);
    event WorkerRegistered(bytes32 indexed workerId, address wallet, bytes32 rfidHash, bool active);

    event RequestCreated(
        uint256 indexed requestId,
        bytes32 indexed binId,
        uint256 fillPct,
        uint256 confidenceBps,
        bytes32 evidenceHash,
        bytes32 reportHash
    );
    event RequestApproved(uint256 indexed requestId, address indexed officer);
    event RequestRejected(uint256 indexed requestId, address indexed officer, bytes32 reasonHash);
    event WorkerAssigned(
        uint256 indexed requestId,
        bytes32 indexed workerId,
        address wallet,
        uint256 amount,
        address indexed officer
    );
    event AssignmentCancelled(uint256 indexed requestId, bytes32 indexed workerId, address indexed officer, bytes32 reasonHash);
    event CollectionTimeoutUpdated(uint32 seconds_);
    /// Job returned to the queue: the worker never finished (aborted by an
    /// officer, or expired by anyone once the timeout passed).
    event CollectionAborted(uint256 indexed requestId, bytes32 indexed workerId, address indexed by, bool expired, bytes32 reasonHash);
    event RfidVerified(uint256 indexed requestId, bytes32 indexed workerId, bytes32 tagHash);
    event RfidMismatch(uint256 indexed requestId, bytes32 indexed binId, bytes32 tagHash, bytes32 expectedWorker);
    event CollectionCompleted(
        uint256 indexed requestId,
        uint256 fillBefore,
        uint256 fillAfter,
        uint256 confidenceBps,
        bool verified,
        bytes32 evidenceHash,
        bytes32 reportHash
    );
    event InvestigationOpened(uint256 indexed requestId, address indexed officer, bytes32 reasonHash);
    event CompletionApproved(uint256 indexed requestId, address indexed officer, bytes32 noteHash);
    event CompletionRejected(uint256 indexed requestId, address indexed officer, bytes32 reasonHash);
    event PaymentReleased(
        uint256 indexed requestId,
        bytes32 indexed workerId,
        address wallet,
        uint256 amount,
        address indexed officer
    );
    event IncidentRecorded(uint256 indexed incidentId, uint8 indexed kind, bytes32 indexed binId, uint256 requestId, bytes32 detailsHash);

    // ----------------------------------------------------------------- errors

    error ZeroAddress();
    error UnknownBin(bytes32 binId);
    error InactiveBin(bytes32 binId);
    error UnknownWorker(bytes32 workerId);
    error InactiveWorker(bytes32 workerId);
    error BinBusy(bytes32 binId, uint256 activeRequest);
    error RequestExists(uint256 requestId);
    error WrongStatus(uint256 requestId, Status status);
    error StaleNonce(uint256 nonce, uint256 lastNonce);
    error BadTimestamp();
    error FillOutOfRange();
    error NotFullEnough(uint256 fillPct, uint256 required);
    error BadSignature(string who);
    error VerdictMismatch(string field);
    error VerdictRejected();
    error ConfidenceTooLow(uint256 confidenceBps, uint256 required);
    error AmountOutOfRange(uint256 amount, uint256 max);
    error InsufficientFunds(uint256 available, uint256 required);
    error InsufficientRemoval(uint256 removed, uint256 required);
    error TransferFailed();
    error TimeoutNotReached(uint256 readyAt, uint256 nowTs);
    error TimeoutOutOfRange();

    constructor(address admin, Policy memory initialPolicy) EIP712("WasteCollectionLedger", "1") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        policy = initialPolicy;
        emit PolicyUpdated(initialPolicy);
    }

    // ================================================================= admin

    function setPolicy(Policy calldata p) external onlyRole(DEFAULT_ADMIN_ROLE) {
        policy = p;
        emit PolicyUpdated(p);
    }

    function setCollectionTimeout(uint32 seconds_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (seconds_ < 15 minutes || seconds_ > 30 days) revert TimeoutOutOfRange();
        collectionTimeout = seconds_;
        emit CollectionTimeoutUpdated(seconds_);
    }

    function registerBins(BinInput[] calldata bins) external onlyRole(DEFAULT_ADMIN_ROLE) {
        for (uint256 i = 0; i < bins.length; i++) {
            BinInput calldata b = bins[i];
            if (b.device == address(0)) revert ZeroAddress();
            Bin storage s = _bins[b.id];
            s.device = b.device;
            s.latE6 = b.latE6;
            s.lngE6 = b.lngE6;
            s.active = b.active;
            emit BinRegistered(b.id, b.device, b.latE6, b.lngE6, b.active);
        }
    }

    function registerWorkers(WorkerInput[] calldata workers) external onlyRole(DEFAULT_ADMIN_ROLE) {
        for (uint256 i = 0; i < workers.length; i++) {
            WorkerInput calldata w = workers[i];
            if (w.wallet == address(0)) revert ZeroAddress();
            Worker storage s = _workers[w.id];
            s.wallet = w.wallet;
            s.rfidHash = w.rfidHash;
            s.active = w.active;
            emit WorkerRegistered(w.id, w.wallet, w.rfidHash, w.active);
        }
    }

    /// @notice Tops up the municipal collection fund (anyone may fund it).
    function fund() external payable {
        emit Funded(msg.sender, msg.value);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// @notice Withdraws unreserved funds. Escrow for assigned work is untouchable.
    function withdraw(uint256 amount, address payable to) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 free = freeFunds();
        if (amount > free) revert InsufficientFunds(free, amount);
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ============================================================= lifecycle

    /// @notice COLLECTION_REQUEST_CREATED. Requires the bin's own signed
    /// fullness report and a positive, signed AI fullness verdict.
    function createRequest(
        uint256 requestId,
        FullnessReport calldata r,
        bytes calldata binSig,
        AiVerdict calldata v,
        bytes calldata aiSig
    ) external onlyRole(GATEWAY_ROLE) whenNotPaused {
        if (requestId == 0 || _requests[requestId].status != Status.None) revert RequestExists(requestId);
        Bin storage bin = _requireActiveBin(r.binId);
        if (bin.activeRequest != 0) revert BinBusy(r.binId, bin.activeRequest);
        if (r.fillPct > 100) revert FillOutOfRange();
        if (r.fillPct < policy.minFillPct) revert NotFullEnough(r.fillPct, policy.minFillPct);
        _checkFresh(bin, r.nonce, r.timestamp);
        _requireSigner(hashFullnessReport(r), binSig, bin.device, "bin");
        _checkVerdict(v, aiSig, requestId, r.binId, VERDICT_FULLNESS, r.evidenceHash);
        if (!v.verified) revert VerdictRejected();

        bin.lastNonce = r.nonce;
        bin.activeRequest = requestId;
        if (requestId > latestRequestId) latestRequestId = requestId;

        Request storage q = _requests[requestId];
        q.binId = r.binId;
        q.status = Status.Requested;
        q.fillDetected = uint16(r.fillPct);
        q.fullnessConfidenceBps = uint16(v.confidenceBps);
        q.fullnessEvidence = r.evidenceHash;
        q.createdAt = uint64(block.timestamp);

        emit RequestCreated(requestId, r.binId, r.fillPct, v.confidenceBps, r.evidenceHash, v.reportHash);
    }

    /// @notice MUNICIPAL_APPROVAL of the collection request.
    function approveRequest(uint256 requestId) external onlyRole(OFFICER_ROLE) whenNotPaused {
        Request storage q = _requireStatus(requestId, Status.Requested);
        q.status = Status.Approved;
        q.approvedAt = uint64(block.timestamp);
        emit RequestApproved(requestId, msg.sender);
    }

    function rejectRequest(uint256 requestId, bytes32 reasonHash) external onlyRole(OFFICER_ROLE) {
        Request storage q = _requests[requestId];
        if (q.status != Status.Requested && q.status != Status.Approved) revert WrongStatus(requestId, q.status);
        q.status = Status.Rejected;
        _bins[q.binId].activeRequest = 0;
        emit RequestRejected(requestId, msg.sender, reasonHash);
    }

    /// @notice WORKER_ASSIGNED. The payment is escrowed now, so the worker
    /// knows the money exists before doing the work.
    function assignWorker(uint256 requestId, bytes32 workerId, uint256 amount)
        external
        onlyRole(OFFICER_ROLE)
        whenNotPaused
    {
        Request storage q = _requireStatus(requestId, Status.Approved);
        Worker storage w = _workers[workerId];
        if (w.wallet == address(0)) revert UnknownWorker(workerId);
        if (!w.active) revert InactiveWorker(workerId);
        if (amount == 0 || amount > policy.maxPayout) revert AmountOutOfRange(amount, policy.maxPayout);
        uint256 free = freeFunds();
        if (amount > free) revert InsufficientFunds(free, amount);

        reserved += amount;
        q.workerId = workerId;
        q.amount = amount;
        q.status = Status.Assigned;
        q.assignedAt = uint64(block.timestamp);
        emit WorkerAssigned(requestId, workerId, w.wallet, amount, msg.sender);
    }

    /// @notice Worker did not show up: return the job to the assignment queue.
    function cancelAssignment(uint256 requestId, bytes32 reasonHash) external onlyRole(OFFICER_ROLE) {
        Request storage q = _requireStatus(requestId, Status.Assigned);
        bytes32 workerId = q.workerId;
        reserved -= q.amount;
        q.amount = 0;
        q.workerId = bytes32(0);
        q.status = Status.Approved;
        emit AssignmentCancelled(requestId, workerId, msg.sender, reasonHash);
    }

    /// @notice RFID_VERIFIED. The bin signs the card it read; the contract
    /// checks it against the assigned worker's registered card. A mismatch is
    /// recorded publicly and changes nothing (the lid stays locked).
    function recordRfid(RfidScan calldata s, bytes calldata binSig)
        external
        onlyRole(GATEWAY_ROLE)
        whenNotPaused
        returns (bool verified)
    {
        Request storage q = _requireStatus(s.requestId, Status.Assigned);
        if (s.binId != q.binId) revert UnknownBin(s.binId);
        Bin storage bin = _bins[q.binId];
        _checkFresh(bin, s.nonce, s.timestamp);
        if (s.timestamp + policy.maxClockSkew < q.assignedAt) revert BadTimestamp();
        _requireSigner(hashRfidScan(s), binSig, bin.device, "bin");
        bin.lastNonce = s.nonce;

        if (s.tagHash == _workers[q.workerId].rfidHash) {
            q.status = Status.InProgress;
            q.startedAt = uint64(block.timestamp);
            emit RfidVerified(s.requestId, q.workerId, s.tagHash);
            return true;
        }
        emit RfidMismatch(s.requestId, q.binId, s.tagHash, q.workerId);
        return false;
    }

    /// @notice BIN_EMPTIED_DETECTED + AI_COMPLETION_VERIFIED. The bin signs its
    /// before/after levels and lid window; the AI signs its verdict. Positive,
    /// physically plausible evidence goes to the municipality for approval;
    /// anything else goes to investigation.
    function submitCompletion(
        CollectionEvidence calldata e,
        bytes calldata binSig,
        AiVerdict calldata v,
        bytes calldata aiSig
    ) external onlyRole(GATEWAY_ROLE) whenNotPaused {
        Request storage q = _requireStatus(e.requestId, Status.InProgress);
        if (e.binId != q.binId) revert UnknownBin(e.binId);
        if (e.fillBefore > 100 || e.fillAfter > 100) revert FillOutOfRange();
        if (e.lidClosedAt < e.lidOpenedAt) revert BadTimestamp();
        if (e.lidOpenedAt + policy.maxClockSkew < q.startedAt) revert BadTimestamp();
        Bin storage bin = _bins[q.binId];
        _checkFresh(bin, e.nonce, e.lidClosedAt);
        _requireSigner(hashCollectionEvidence(e), binSig, bin.device, "bin");
        _checkVerdict(v, aiSig, e.requestId, e.binId, VERDICT_COMPLETION, e.evidenceHash);
        bin.lastNonce = e.nonce;

        q.fillBefore = uint16(e.fillBefore);
        q.fillAfter = uint16(e.fillAfter);
        q.completionConfidenceBps = uint16(v.confidenceBps);
        q.completionEvidence = e.evidenceHash;
        q.completedAt = uint64(block.timestamp);

        bool ok = v.verified && v.confidenceBps >= policy.minConfidenceBps && _physicallyEmptied(q);
        q.completionVerified = ok;
        q.status = ok ? Status.AwaitingApproval : Status.Investigation;
        emit CollectionCompleted(e.requestId, e.fillBefore, e.fillAfter, v.confidenceBps, ok, e.evidenceHash, v.reportHash);
    }

    /// @notice The worker scanned in but never finished (or vanished after
    /// assignment). An officer can pull the job back to the queue at any time.
    function abortCollection(uint256 requestId, bytes32 reasonHash) external onlyRole(OFFICER_ROLE) {
        Request storage q = _requests[requestId];
        if (q.status != Status.InProgress) revert WrongStatus(requestId, q.status);
        _returnToQueue(requestId, q, msg.sender, false, reasonHash);
    }

    /// @notice Permissionless escape hatch: once the timeout has passed, ANYONE
    /// can return a stalled Assigned/InProgress job to the queue and release
    /// the escrow. No officer, and no server, has to be online for funds and
    /// the bin to become usable again.
    function expireCollection(uint256 requestId) external {
        Request storage q = _requests[requestId];
        uint256 since;
        if (q.status == Status.Assigned) since = q.assignedAt;
        else if (q.status == Status.InProgress) since = q.startedAt;
        else revert WrongStatus(requestId, q.status);
        uint256 readyAt = since + collectionTimeout;
        if (block.timestamp < readyAt) revert TimeoutNotReached(readyAt, block.timestamp);
        _returnToQueue(requestId, q, msg.sender, true, bytes32(0));
    }

    function _returnToQueue(uint256 requestId, Request storage q, address by, bool expired, bytes32 reasonHash) internal {
        bytes32 workerId = q.workerId;
        reserved -= q.amount;
        _workers[workerId].rejected += 1;
        q.amount = 0;
        q.workerId = bytes32(0);
        q.startedAt = 0;
        q.assignedAt = 0;
        q.status = Status.Approved; // bin stays reserved for this request; officer reassigns
        emit CollectionAborted(requestId, workerId, by, expired, reasonHash);
    }

    /// @notice An officer wants to look closer before approving.
    function openInvestigation(uint256 requestId, bytes32 reasonHash) external onlyRole(OFFICER_ROLE) {
        _requireStatus(requestId, Status.AwaitingApproval).status = Status.Investigation;
        emit InvestigationOpened(requestId, msg.sender, reasonHash);
    }

    /// @notice MUNICIPAL_COMPLETION_APPROVED. An officer may overrule the AI's
    /// doubt after investigating, but never the physics.
    function approveCompletion(uint256 requestId, bytes32 noteHash) external onlyRole(OFFICER_ROLE) whenNotPaused {
        Request storage q = _requests[requestId];
        if (q.status != Status.AwaitingApproval && q.status != Status.Investigation) revert WrongStatus(requestId, q.status);
        if (!_physicallyEmptied(q)) {
            revert InsufficientRemoval(q.fillBefore > q.fillAfter ? q.fillBefore - q.fillAfter : 0, policy.minFillRemoved);
        }
        q.status = Status.CompletionApproved;
        emit CompletionApproved(requestId, msg.sender, noteHash);
    }

    function rejectCompletion(uint256 requestId, bytes32 reasonHash) external onlyRole(OFFICER_ROLE) {
        Request storage q = _requests[requestId];
        if (q.status != Status.AwaitingApproval && q.status != Status.Investigation) revert WrongStatus(requestId, q.status);
        reserved -= q.amount;
        q.status = Status.Rejected;
        _bins[q.binId].activeRequest = 0;
        _workers[q.workerId].rejected += 1;
        emit CompletionRejected(requestId, msg.sender, reasonHash);
    }

    /// @notice PAYMENT_CONFIRMED. Pays the escrowed amount to the worker wallet
    /// registered by the municipality. Nothing in the call chooses the payee.
    function releasePayment(uint256 requestId) external onlyRole(OFFICER_ROLE) whenNotPaused nonReentrant {
        Request storage q = _requireStatus(requestId, Status.CompletionApproved);
        Worker storage w = _workers[q.workerId];
        uint256 amount = q.amount;

        q.status = Status.Paid;
        q.paidAt = uint64(block.timestamp);
        reserved -= amount;
        totalPaid += amount;
        w.completed += 1;
        w.earned += amount;
        Bin storage bin = _bins[q.binId];
        bin.activeRequest = 0;
        bin.collections += 1;

        (bool ok, ) = w.wallet.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit PaymentReleased(requestId, q.workerId, w.wallet, amount, msg.sender);
    }

    /// @notice Public, tamper-evident log of rejected detections, offline bins,
    /// RFID abuse and other anomalies. Moves no funds.
    function recordIncident(uint8 kind, bytes32 binId, uint256 requestId, bytes32 detailsHash)
        external
        returns (uint256 incidentId)
    {
        if (!hasRole(GATEWAY_ROLE, msg.sender) && !hasRole(OFFICER_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, GATEWAY_ROLE);
        }
        incidentId = ++incidentCount;
        emit IncidentRecorded(incidentId, kind, binId, requestId, detailsHash);
    }

    // ================================================================= views

    function freeFunds() public view returns (uint256) {
        uint256 bal = address(this).balance;
        return bal > reserved ? bal - reserved : 0;
    }

    function getRequest(uint256 requestId) external view returns (Request memory) {
        return _requests[requestId];
    }

    function getBin(bytes32 binId) external view returns (Bin memory) {
        return _bins[binId];
    }

    function getWorker(bytes32 workerId) external view returns (Worker memory) {
        return _workers[workerId];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function hashFullnessReport(FullnessReport calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(FULLNESS_TYPEHASH, r)));
    }

    function hashRfidScan(RfidScan calldata s) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RFID_TYPEHASH, s)));
    }

    function hashCollectionEvidence(CollectionEvidence calldata e) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(COMPLETION_TYPEHASH, e)));
    }

    function hashAiVerdict(AiVerdict calldata v) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VERDICT_TYPEHASH, v)));
    }

    // ============================================================== internal

    function _requireActiveBin(bytes32 binId) internal view returns (Bin storage bin) {
        bin = _bins[binId];
        if (bin.device == address(0)) revert UnknownBin(binId);
        if (!bin.active) revert InactiveBin(binId);
    }

    function _requireStatus(uint256 requestId, Status expected) internal view returns (Request storage q) {
        q = _requests[requestId];
        if (q.status != expected) revert WrongStatus(requestId, q.status);
    }

    function _checkFresh(Bin storage bin, uint256 nonce, uint256 timestamp) internal view {
        if (nonce <= bin.lastNonce) revert StaleNonce(nonce, bin.lastNonce);
        if (timestamp > block.timestamp + policy.maxClockSkew) revert BadTimestamp();
        if (timestamp + policy.maxReportAge < block.timestamp) revert BadTimestamp();
    }

    function _physicallyEmptied(Request storage q) internal view returns (bool) {
        return q.fillBefore >= q.fillAfter + policy.minFillRemoved;
    }

    function _checkVerdict(
        AiVerdict calldata v,
        bytes calldata aiSig,
        uint256 requestId,
        bytes32 binId,
        uint8 kind,
        bytes32 evidenceHash
    ) internal view {
        if (v.requestId != requestId) revert VerdictMismatch("requestId");
        if (v.binId != binId) revert VerdictMismatch("binId");
        if (v.kind != kind) revert VerdictMismatch("kind");
        if (v.evidenceHash != evidenceHash) revert VerdictMismatch("evidenceHash");
        if (v.confidenceBps > 10000) revert VerdictMismatch("confidenceBps");
        if (kind == VERDICT_FULLNESS && v.confidenceBps < policy.minConfidenceBps) {
            revert ConfidenceTooLow(v.confidenceBps, policy.minConfidenceBps);
        }
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hashAiVerdict(v), aiSig);
        if (err != ECDSA.RecoverError.NoError || !hasRole(VERIFIER_ROLE, signer)) revert BadSignature("verifier");
    }

    function _requireSigner(bytes32 digest, bytes calldata sig, address expected, string memory who) internal pure {
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError || signer != expected) revert BadSignature(who);
    }
}
