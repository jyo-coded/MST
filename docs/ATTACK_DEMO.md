# Attack demo script (about 90 seconds)

Run each attack, show the rejection reason, and point at the on-chain record. Rehearse these before presenting; the commands below reflect the API routes in `server/src/api.ts`.

Login first:
```bash
TOKEN=$(curl -s -H 'content-type: application/json' \
  -d '{"email":"officer@municipal.demo","password":"demo1234"}' \
  http://localhost:8080/api/auth/login | jq -r .token)
```

## 1. Wrong worker at the bin (simulated)
```bash
curl -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"binId":"BIN-001","card":"wrong"}' http://localhost:8080/api/sim/queue-card
```
Expected: lid stays locked, `RfidMismatch` event on-chain, request stays `EN_ROUTE`.

## 2. Blocked sensor pretending the bin is full (simulated)
```bash
curl -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"binId":"BIN-004"}' http://localhost:8080/api/sim/obstruction
```
Expected: detection rejected, reasons show `SECONDARY_AGREES`, `GRADUAL_FILL`, `IR_ACTIVITY` failing, no request created.

## 3. Replayed device packet
Capture one signed hardware POST and send it again within 15 s. Expected: `replayed packet (seq ≤ …)` from the ingest endpoint.

## 4. Fake "emptied" on the real bin (needs the load cell)
Cover both ultrasonic sensors with cardboard so the level reads near empty during a collection, without removing waste. Expected: `WEIGHT_DROPPED` fails, the collection goes to Investigation, no payment. This is the strongest live demo because a judge can do it with their hand.

## 5. Stalled job frees itself
On a local chain, call `expireCollection(requestId)` from any account after `collectionTimeout` (set it to 15 minutes with `setCollectionTimeout` for the demo). Expected: escrow released, job back in the queue, `CollectionAborted(expired=true)` event.

Status when this was written: the happy-path end-to-end run was executed against a fresh local chain; attacks 1 to 5 were not run live. Rehearse them on your hardware.
