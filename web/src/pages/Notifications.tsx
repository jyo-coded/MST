import clsx from "clsx";
import { Bell, CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Empty, PageHeader, Panel, Segmented, Skeleton } from "../components/ui";
import { post } from "../lib/api";
import { ago, dateTime } from "../lib/format";
import { useNotifications } from "../lib/queries";
import type { Notification } from "../lib/types";

const ICON: Record<Notification["severity"], { icon: ReactNode; cls: string; label: string }> = {
  critical: { icon: <CircleAlert className="h-[18px] w-[18px]" />, cls: "bg-bad-bg text-bad", label: "Critical" },
  warning: { icon: <TriangleAlert className="h-[18px] w-[18px]" />, cls: "bg-warn-bg text-warn", label: "Warning" },
  success: { icon: <CircleCheck className="h-[18px] w-[18px]" />, cls: "bg-good-bg text-good", label: "Done" },
  info: { icon: <Info className="h-[18px] w-[18px]" />, cls: "bg-sunken text-ink-2", label: "Info" },
};

export function Notifications() {
  const { data } = useNotifications();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<"all" | "unread" | "alerts">("all");
  const rows = useMemo(
    () => (data ?? []).filter((n) => (filter === "unread" ? !n.read : filter === "alerts" ? n.severity === "critical" || n.severity === "warning" : true)),
    [data, filter],
  );
  const unread = (data ?? []).filter((n) => !n.read).length;

  const markRead = async (ids?: number[]) => {
    await post("/notifications/read", ids ? { ids } : {});
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  const open = async (n: Notification) => {
    if (!n.read) markRead([n.id]);
    if (n.requestId) navigate(`/app/requests/${n.requestId}`);
    else if (n.binId) navigate(`/app/bins/${n.binId}`);
    else if (n.workerId) navigate(`/app/workers/${n.workerId}`);
  };

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="Alerts the system raised for the municipality: rejected readings, RFID mismatches, investigations, failed transactions and completed payments."
        actions={
          <Button variant="secondary" size="sm" disabled={unread === 0} onClick={() => markRead()}>
            Mark all as read
          </Button>
        }
      />
      <Panel flush>
        <div className="border-b border-line-2 px-4 py-3">
          <Segmented
            size="sm"
            value={filter}
            onChange={setFilter}
            items={[
              { value: "all", label: `All · ${data?.length ?? 0}` },
              { value: "unread", label: `Unread · ${unread}` },
              { value: "alerts", label: "Alerts" },
            ]}
          />
        </div>
        {!data ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <Empty icon={<Bell className="h-8 w-8" />} title={filter === "unread" ? "You're all caught up" : "No notifications"} />
        ) : (
          <ul className="divide-y divide-line-2">
            {rows.map((n) => {
              const s = ICON[n.severity] ?? ICON.info;
              return (
                <li key={n.id}>
                  <button onClick={() => open(n)} className={clsx("flex w-full items-start gap-3.5 px-5 py-3.5 text-left transition-colors hover:bg-raised", !n.read && "bg-surface")}>
                    <span className={clsx("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md", s.cls)} aria-label={s.label}>
                      {s.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className={clsx("truncate text-[14px]", n.read ? "text-ink-2" : "font-medium text-ink")}>{n.title}</span>
                        {!n.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-prog-dot" aria-label="Unread" />}
                      </span>
                      {n.body && <span className="mt-0.5 block text-[13px] text-ink-2">{n.body}</span>}
                      <span className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-ink-3">
                        <span title={dateTime(n.createdAt)}>{ago(n.createdAt)}</span>
                        <span>{s.label}</span>
                        {n.binId && <span>{n.binId}</span>}
                        {n.requestId && <span className="font-mono">REQ-{String(n.requestId).padStart(5, "0")}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
