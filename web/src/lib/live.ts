import { useMemo } from "react";
import { markerState } from "@astra/shared";
import { useLive } from "./store";
import type { Bin } from "./types";

/** Overlays streamed telemetry on the last fetched bin state. */
export function useLiveBins(bins?: Bin[]): Bin[] {
  const telemetry = useLive((s) => s.telemetry);
  return useMemo(
    () =>
      (bins ?? []).map((b) => {
        const t = telemetry[b.id];
        if (!t || (b.lastHeartbeat && new Date(t.ts) < new Date(b.lastHeartbeat))) return b;
        const fillPct = t.fill;
        return {
          ...b,
          fillPct,
          fill2Pct: t.fill2,
          lidState: t.lid,
          servoState: t.servo,
          irStatus: t.ir,
          marker: markerState({ status: b.status, online: b.online, fillPct, monitorPct: b.monitorPct, requestStatus: b.request?.status ?? null }),
        };
      }),
    [bins, telemetry],
  );
}

export function useLiveBin(bin?: Bin | null): Bin | null {
  const list = useLiveBins(bin ? [bin] : []);
  return list[0] ?? null;
}
