# Astra Waste

**Intelligent Waste Collection. Verified by Data. Settled on Blockchain.**

Smart bins report when they are full. Sensor fusion checks the reading is real. The municipality approves and assigns the nearest worker, the bin checks the worker's RFID card before unlocking, both ultrasonic sensors prove the waste was removed, and the worker is paid in MSTC on MST Blockchain. Every decision is a real transaction you can verify on MSTScan.

```
IoT detects → AI verifies → municipality approves → worker assigned → RFID at the bin →
lid unlocks → collection → sensors verify emptying → AI re-verifies → municipality approves → MST payment
```

## Run it

Node 20+.

```bash
npm install
npm run local        # local rehearsal chain + contract + dashboard, no keys needed
```

Open http://localhost:8080 (port busy? `set PORT=3000` on Windows, `PORT=3000` on macOS/Linux).

- Municipality: `officer@municipal.demo` / `demo1234`
- Worker (phone-sized app): any worker, PIN `1234`
- **Demo** button → *Simulate full bin · end to end* runs the whole storyline.

## Deploy on MST Testnet

1. Create `.env` in the repo root (see `.env.example`):
   ```
   NETWORK=testnet
   MST_PRIVATE_KEY=0x...
   ```
2. Fund that key's address with ~1 test MSTC from the MST faucet.
3. `npm run deploy && npm run setup && npm start`

`deploy` publishes `WasteCollectionLedger` (chain 91562037) and prints its MSTScan link; `setup` registers bins and workers and funds the payment pool. From then on every approval, assignment, RFID proof, completion and payment is an MST transaction.

## What's inside

| Path | What |
|---|---|
| `contracts/` | `WasteCollectionLedger.sol`: request lifecycle, EIP-712 signatures from the bin device and AI verifier, escrow on assignment, pay-once release to the registered worker wallet. `npm test` runs 20 Hardhat tests. |
| `server/` | Express + PostgreSQL (embedded PGlite, or `DATABASE_URL`). MST SDK ledger service, HMAC-authenticated ESP32 ingest, sensor-fusion AI (optional Qwen second opinion), enforced state machines, simulation engine, SSE realtime. |
| `web/` | React dashboard (overview, live map, requests, assignment, active collections, verification center, bins, workers, payments, blockchain audit, notifications, settings) and the worker app. BridgeKey signing supported. |
| `shared/` | Lifecycle stages and state machines used by both sides. |
| `config/city.json` | Municipality, 24 bins, 8 workers. `"hardware": true` marks the ESP32 bin. |

## Safeguards

- A random worker can't claim a job: the ledger only accepts an RFID proof signed by the bin for the assigned worker's card, and only pays the wallet registered for that worker.
- A collection can't be completed from the UI: completion needs bin-signed before/after readings plus an AI verdict, and the contract refuses approval if less than the policy minimum was removed.
- Transaction hashes are never faked; "confirmed" is shown only after a receipt.
