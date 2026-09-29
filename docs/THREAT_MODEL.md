# Threat model & Honest Residual Risk Analysis

> **Operational Mandate**: This document provides an intellectually honest threat model for the Astra Waste Municipal Waste Collection System. Read this before evaluating platform safeguards or running the Attack Arena.

---

## 1. Key Distribution & Cryptographic Authority

| Key / Identity | Held By | Function | Security Boundary |
|---|---|---|---|
| **Bin Device Key** (`secp256k1`) | Provisioned per-bin firmware (and gateway mirror) | Signs EIP-712 typed data: fullness reports, RFID tap events, completion evidence | Physical bin enclosure & flash memory |
| **Worker Wallet Key** | Worker's BridgeKey / mobile keystore | Signs 2FA proximity challenges, receives MSTC payouts, holds staked security deposits | Worker's mobile device enclave |
| **Municipal Officer Key** | Municipal authority (`BridgeKey` / server wallet) | Authorizes collection requests, approves completions, triggers release of escrow | Officer workstation / HSM |
| **Autonomous Watcher Key** | Independent Watcher daemon (`server/src/workflow/watcher.ts`) | Continuously scans citizen challenges, verifies GPS bounds, slashes worker stakes, disburses citizen bounties | Autonomous background service |
| **Transfer Station Checkpoint Key** | Authorized Eco-Dump / Waste Processing Facility | Confirms arrival and custody transfer of collected municipal waste | Transfer weighbridge terminal |
| **Ledger Admin Key** | Protocol Deployer / Municipal Admin | Registers bins, enrolls workers, sets parameters, funds escrow pool | Multi-sig / Cold storage |

---

## 2. Attacks, Defenses, and Mitigations

| Attack Scenario | Primary Defense | Active Mitigation | Residual Risk |
|---|---|---|---|
| **Telemetry Replay** | Sequence numbers (`seq`), HMAC-SHA256, 5-minute timestamp validity window | Ingest pipeline rejects duplicate or out-of-order sequence packets | Attacker who compromises the per-device HMAC secret |
| **On-Chain Evidence Replay** | Strictly increasing nonces per bin, EIP-712 domain separation (chain ID + contract address), request-bound hash | Verified in `WasteCollectionLedger.sol` via cryptographic signature recovery | None known |
| **Ultrasonic Sensor Spoofing** | Dual independent ultrasonic sensors must agree within tolerance | IR mouth counter cross-checks physical deposit velocity; fill-velocity filter rejects physically impossible jumps | Coordinated physical obstruction of both sensors simultaneously |
| **Thermal Sensor Tampering / Lighter on Probe** | Multi-sensor cross check (Dual Ultrasonic + Load Cell + Ambient Temp correlation) | Instant on-chain commit of tamper-proof incident receipt (Kind 5) with immutable Keccak-256 hash | Sensor destroyed before packet transmission completes |
| **Cloned RFID Card Exploitation** | RFID UID is treated as a weak modality, not authoritative proof | **Second Worker Factor (2FA)**: Worker mobile app signs an ephemeral challenge while within 35m GPS radius of the bin | Relay of challenge across remote cellular connection (see Residual Risks below) |
| **Ghost Dumping (Empty Bin, Dump Roadside)** | **Chain of Custody to Dump Yard**: Checkpoint 2 at municipal processing facility | Escrow payment is locked until the authorized transfer station registers weigh-in and waste custody | Collusion between worker and transfer station gatekeeper |
| **False Completion by Rogue Worker** | Sensor delta verification (before vs. after level must decrease past threshold) | **Citizen Challenge Window (180s)**: Citizens submit location-stamped reports; live Watcher slashes worker stake | Low citizen density in remote or industrial wards |
| **Municipal Single Point of Failure** | Public Audit Explorer with in-browser Keccak-256 re-hasher | Evaluator & citizen verification outside municipal intranet | Municipal officer key compromise can still cause denial-of-service |

---

## 3. Honest Residual Risks (Where the System Is Honestly Still Weak)

### 3.1 Relay Attacks (RF / Beacon / Rover Distance Emulation)
* **The Vulnerability**: A remote attacker could relay a live BLE/Wi-Fi beacon or 2FA challenge message from a bin to a rover or worker phone located kilometers away using an internet tunnel.
* **Current Defense**: Signal strength (RSSI) bounds, short challenge expiration windows (15 seconds), and cellular GPS proximity cross-checking (<35m radius).
* **Honest Assessment**: RSSI thresholds and timing checks add friction but do **not** mathematically eliminate relay attacks. An attacker with low-latency 5G backhaul can tunnel challenge packets in under 40ms.
* **The Real Fix**: True distance-bounding protocols utilizing time-of-flight (ToF) acoustic pulses or Ultra-Wideband (UWB IEEE 802.15.4z). This is research-grade hardware complexity and is deliberately not claimed as solved in this demo.

### 3.2 Device Key Extraction on Commodity ESP32
* **The Vulnerability**: Standard ESP32 microcontrollers store firmware and flash keys in external SPI flash without hardware-enforced physical tamper resistance. An attacker with physical access and an oscilloscope or SPI chip clip can dump the flash and extract device secrets.
* **Current Defense**: Firmware uses per-bin unique keys derived from separate salts; compromise of one bin does not compromise neighboring bins.
* **Roadmap & Proper Fix**: Secure Boot v2 and Flash Encryption with hardware secure elements (e.g., Microchip ATECC608A or Infineon OPTIGA™ Trust M) on the bin controller board. We explicitly state this as a hardware roadmap item.

### 3.3 Static RFID UIDs Are Readily Cloneable
* **The Vulnerability**: 13.56 MHz Mifare Classic or 125 kHz EM4100 RFID cards transmit a static, unencrypted UID. Inexpensive handheld writers (Proxmark, Flipper Zero) clone these in under two seconds.
* **System Design Philosophy**: The system **never** treats an RFID UID as definitive proof of identity. RFID is treated strictly as a weak physical presence trigger. It is layered with:
  1. Worker-assigned schedule validation;
  2. GPS proximity checks;
  3. Second Worker Factor (BridgeKey/Ed25519 signed mobile challenge);
  4. Physical load delta and sensor fusion.

### 3.4 Challenge Window Requires an Active Watcher Daemon
* **The Vulnerability**: Introducing a 180-second citizen challenge window is purely theoretical if nobody acts upon the challenge reports before municipal payout occurs.
* **Current Implementation**: Astra Waste runs a live, autonomous `WatcherService` (`server/src/workflow/watcher.ts`). The watcher:
  1. Continuously monitors all pending payments;
  2. Queries registered citizen reports;
  3. Verifies reporter GPS proximity (<50m of bin coordinate);
  4. Automatically halts payment and places the job in `INVESTIGATION`;
  5. Slashes worker stake and awards a 0.02 MSTC bounty to the citizen reporter.
* **Residual Risk**: If the watcher service crashes or encounters RPC congestion, the challenge window could expire unmoderated. The production architecture requires redundant decentralized watcher nodes.

### 3.5 Complexity Risk as the Primary Adversary
* **The Trade-Off**: Every mechanism added—citizen challenges, dual checkpoints, multi-wallet autonomous loops, 2FA signing, and reputation staking—expands the protocol's attack and failure surface.
* **Failure Modes**:
  - Worker cell phone loses battery: Unable to complete 2FA even though waste was emptied.
  - Transfer station scanner offline: Worker legitimate payout is delayed despite full collection.
  - Citizen griefing: Malicious citizens filing false challenges to temporarily lock worker stakes.
* **Mitigation**: The system incorporates fail-safes (manual municipal override, stake slashing only upon verifiable sensor contradiction, reputation recovery on honest dispute resolution).

---

## 4. Attack Arena Scope & Defined Bounds

Judges and evaluators are invited to test platform defenses in the interactive **Attack Arena** (`/arena`):
1. **Replay Attack**: Feeding previously valid telemetry sequence packets.
2. **Thermal / Lighter Tamper**: Applying rapid heat to trigger emergency incident generation without spoofing fill levels.
3. **Ghost Dump Simulation**: Claiming emptying without transfer facility delivery.
4. **Forged 2FA Challenge**: Presenting cloned RFID cards without valid wallet signature.

A testnet bounty of **100 MSTC** is reserved for any exploit that compromises ledger state without triggering rejection or incident alerts.
