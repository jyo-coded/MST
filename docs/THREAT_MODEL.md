# Threat model (what is trusted, what is not)

This is the honest version. Read it before you read the safeguards in the README.

## Who holds which key today

| Key | Held by | What it can do |
|---|---|---|
| Bin device key (one per bin) | **Backend server** (derived from `DEVICE_MNEMONIC`) | Signs the EIP-712 fullness, RFID and completion evidence |
| ESP32 HMAC secret | The ESP32 and the server | Authenticates each telemetry POST; **not** an on-chain signature |
| Gateway, verifier, officer keys | Backend server (default) | Relay evidence, sign AI verdicts, approve and release payment |
| Admin key | Operator | Registers bins and workers, funds the pool, sets policy |

Consequence: the contract enforces separate roles, but with the default deployment one backend controls all of them. On-chain "bin-signed" means "signed with the bin's key by the gateway", not "signed inside the ESP32". What the chain does give you today is an append-only, publicly verifiable record and hard rules the backend cannot bend: it cannot pay a wallet other than the registered one, cannot pay twice, cannot approve a collection whose signed readings show too little waste removed, and cannot touch escrowed funds.

## Attacks and defenses

| Attack | Defense | Residual risk |
|---|---|---|
| Replay an old telemetry packet | Per-device HMAC, strictly increasing `seq`, 5-minute clock window | Attacker with the device secret |
| Replay old on-chain evidence | Per-bin strictly increasing nonce, EIP-712 domain (chain + contract), request-bound digests | None known |
| Block or fool the ultrasonic sensors so a bin looks full or empty | Two sensors must agree, gradual-fill and IR-deposit checks, lid-open timing | Both sensors blocked consistently |
| Fake the "emptied" reading | **Load cell** must lose weight (`WEIGHT_DROPPED`, critical); set `REQUIRE_WEIGHT=1` to make it mandatory on hardware bins | Someone removes weight without collecting it (see chain of custody below) |
| Wrong worker claims the job | Bin-signed RFID scan must match the assigned worker's hash; mismatches are recorded on-chain | **Cloned card** (see below) |
| Recover a worker's card UID from chain data | RFID hash is keyed with a server secret, so 4-byte UIDs cannot be brute-forced from public events | Anyone who physically reads a card can still clone it |
| Job stalls forever and locks escrow and the bin | `abortCollection` (officer) and `expireCollection` (**anyone**, after `collectionTimeout`) return the job to the queue and free the escrow | None known |
| Officer pays for work that did not happen | `approveCompletion` reverts if signed before/after levels show too little removed | Officer approving after a compromised backend signs false levels |
| LLM second opinion misbehaves | It can only make a verdict stricter, never looser | Availability (a stricter model can block valid work) |

## Known gaps (do not claim these are solved)

1. **Device keys live on the server.** Production: generate the key inside the ESP32 (or a secure element), sign EIP-712 on the device, and register only the public address. The backend then cannot forge bin evidence.
2. **One backend holds gateway, verifier and officer keys.** Production: run the verifier as a separate service with its own key, require a human officer wallet (BridgeKey) for approvals, and move toward a verifier quorum.
3. **RFID UIDs are cloneable.** Production: add a challenge-response signed by the worker's wallet in the worker app, checked when the lid unlocks.
4. **No chain of custody.** The system proves waste left the bin, not that it reached a processing site. Production: a second checkpoint at the transfer station before payment releases.
5. **Single approver.** The municipality approves and pays. A citizen challenge window would make third-party verification possible.
6. **The demo fleet is mostly simulated.** Only bins with `"hardware": true` in `config/city.json` are real. Simulated bins are labeled `simulation` in the dashboard and in telemetry rows.
