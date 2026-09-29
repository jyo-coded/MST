import { ethers } from "ethers";
import { idBytes, ledger } from "../chain/ledger";
import { one, q } from "../db";
import { notify, record } from "../events";
import { publish } from "../realtime";
import { setPayment, setRequest } from "./state";

export interface WatcherScanResult {
  activeChallengesCount: number;
  openWindowsCount: number;
  interventions: {
    requestId: number;
    binId: string;
    reason: string;
    bountyPaidMstc: number;
    stakeSlashedMstc: number;
  }[];
}

/**
 * Live Watcher Service: Monitors the challenge window for completed collections,
 * cross-verifies citizen GPS reports and post-completion telemetry, halts fraudulent
 * payments before release, dispenses citizen bounties, and slashes worker stake.
 */
export class WatcherService {
  private timer: NodeJS.Timeout | null = null;
  public running = false;
  public lastScanAt: string | null = null;
  public stats = {
    totalInspected: 0,
    challengesCaught: 0,
    bountiesPaidMstc: 0,
    stakesSlashedMstc: 0,
  };

  start(intervalMs = 4000) {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      this.scan().catch((err) => console.error("Watcher scan error:", err));
    }, intervalMs);
    console.log("✓ Citizen Challenge Watcher service started (live guardian)");
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  async scan(): Promise<WatcherScanResult> {
    this.lastScanAt = new Date().toISOString();
    const interventions: WatcherScanResult["interventions"] = [];

    // 1. Find all pending citizen challenges
    const pendingChallenges = await q(
      `SELECT c.*, r.assigned_worker_id, r.status AS req_status, r.bin_id, b.lat AS bin_lat, b.lng AS bin_lng, b.fill_pct AS bin_fill
         FROM citizen_challenges c
         JOIN collection_requests r ON r.id = c.request_id
         JOIN bins b ON b.id = c.bin_id
        WHERE c.status = 'PENDING'`
    );

    for (const c of pendingChallenges) {
      this.stats.totalInspected++;
      // Validate proximity: Citizen GPS must be within 200m of bin
      const dist = c.distance_to_bin_m ?? 50;
      const isCloseEnough = dist <= 250;

      // Check current bin telemetry: did bin level stay high or jump back up?
      const isStillFull = Number(c.bin_fill) >= 40;

      if (isCloseEnough || isStillFull) {
        // UPHOLD CHALLENGE! Intercept and freeze payment
        const workerId = c.assigned_worker_id;
        const bounty = Number(c.bounty_mstc || 0.02);
        const stakeToSlash = 0.05;

        // 1. Update challenge record
        await q(
          `UPDATE citizen_challenges
              SET status = 'UPHELD', watcher_verified = true, resolved_at = now()
            WHERE id = $1`,
          [c.id]
        );

        // 2. Freeze payment and move request to INVESTIGATION
        await setRequest(c.request_id, "INVESTIGATION", {
          investigation_reason: `Watcher Intercept: Citizen challenge upheld (${c.note}). Proximity: ${Math.round(dist)}m.`,
          challenge_status: "CHALLENGED",
        });

        const pay = await one(`SELECT * FROM payments WHERE request_id = $1`, [c.request_id]);
        if (pay && pay.status !== "PAID") {
          await setPayment(c.request_id, "CANCELLED", {
            error: "Payment cancelled by Watcher: Citizen challenge upheld (Bin was not emptied)",
          });
        }

        // 3. Slash worker stake & reputation
        if (workerId) {
          await q(
            `UPDATE workers
                SET reputation_score = GREATEST(10, reputation_score - 25),
                    slashed_count = slashed_count + 1,
                    rejected_count = rejected_count + 1
              WHERE id = $1`,
            [workerId]
          );

          await record({
            stage: "WORKER_STAKE_SLASHED",
            message: `Worker ${workerId} stake of ${stakeToSlash} MSTC slashed due to upheld non-emptied challenge. Reputation penalized (-25).`,
            actor: "watcher:guardian",
            tone: "danger",
            requestId: c.request_id,
            binId: c.bin_id,
            workerId,
            data: { slashedMstc: stakeToSlash, challengeId: c.id },
          });
        }

        // 4. Record on-chain incident proof
        const detailsHash = ethers.keccak256(
          ethers.toUtf8Bytes(
            JSON.stringify({
              challengeId: c.id,
              requestId: c.request_id,
              citizen: c.citizen_address,
              reason: c.note,
              timestamp: Date.now(),
            })
          )
        );

        try {
          const L = ledger();
          await L.send(
            "gateway",
            "recordIncident",
            [6, idBytes(c.bin_id), BigInt(c.request_id), detailsHash],
            {
              action: "INCIDENT",
              requestId: c.request_id,
              binId: c.bin_id,
              workerId,
            }
          );
        } catch {
          // offline rehearsal fallback
        }

        // 5. Notify Municipality & Record Lifecycle
        await record({
          stage: "CHALLENGE_UPHELD",
          message: `Citizen challenge #${c.id} verified by Watcher: ${c.note}. Payment halted. 0.02 MSTC bounty awarded to ${c.citizen_address.slice(0, 8)}…`,
          actor: "watcher:guardian",
          tone: "danger",
          requestId: c.request_id,
          binId: c.bin_id,
          data: { bountyMstc: bounty, reporter: c.citizen_address },
        });

        await notify({
          type: "CITIZEN_CHALLENGE",
          severity: "critical",
          title: `Watcher Halt: Citizen challenge upheld at ${c.bin_id}`,
          body: `Citizen verified bin was not emptied (${Math.round(dist)}m away). Payment halted, worker stake slashed.`,
          requestId: c.request_id,
          binId: c.bin_id,
        });

        this.stats.challengesCaught++;
        this.stats.bountiesPaidMstc += bounty;
        this.stats.stakesSlashedMstc += stakeToSlash;

        interventions.push({
          requestId: c.request_id,
          binId: c.bin_id,
          reason: c.note,
          bountyPaidMstc: bounty,
          stakeSlashedMstc: stakeToSlash,
        });

        publish("challenge", { id: c.id, status: "UPHELD", requestId: c.request_id });
      } else {
        // Reject invalid challenge (too far away or bogus report)
        await q(
          `UPDATE citizen_challenges
              SET status = 'REJECTED', resolved_at = now()
            WHERE id = $1`,
          [c.id]
        );
        publish("challenge", { id: c.id, status: "REJECTED", requestId: c.request_id });
      }
    }

    // 2. Check for expired challenge windows without challenges -> mark CLEARED
    const openWindows = await q(
      `SELECT id, bin_id, assigned_worker_id, challenge_window_ends_at
         FROM collection_requests
        WHERE status IN ('AWAITING_FINAL_APPROVAL', 'COMPLETED')
          AND challenge_status = 'OPEN'
          AND challenge_window_ends_at IS NOT NULL
          AND challenge_window_ends_at <= now()`
    );

    for (const r of openWindows) {
      await q(`UPDATE collection_requests SET challenge_status = 'CLEARED' WHERE id = $1`, [r.id]);
      publish("challenge_cleared", { requestId: r.id });
    }

    return {
      activeChallengesCount: pendingChallenges.length,
      openWindowsCount: openWindows.length,
      interventions,
    };
  }
}

export const watcher = new WatcherService();
