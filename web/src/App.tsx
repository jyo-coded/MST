import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/Shell";
import { useNotifications, useOverview } from "./lib/queries";
import { useSession } from "./lib/store";
import { Active } from "./pages/Active";
import { Assign } from "./pages/Assign";
import { Audit } from "./pages/Audit";
import { BinDetail } from "./pages/BinDetail";
import { Bins } from "./pages/Bins";
import { Landing } from "./pages/Landing";
import { LiveMap } from "./pages/LiveMap";
import { Notifications } from "./pages/Notifications";
import { Overview } from "./pages/Overview";
import { Payments } from "./pages/Payments";
import { RequestDetail } from "./pages/RequestDetail";
import { Requests } from "./pages/Requests";
import { Settings } from "./pages/Settings";
import { Verification } from "./pages/Verification";
import { WorkerProfile } from "./pages/WorkerProfile";
import { Workers } from "./pages/Workers";
import { WorkerApp } from "./pages/worker/WorkerApp";

function RequireRole({ roles, children }: { roles: string[]; children: ReactNode }) {
  const user = useSession((s) => s.user);
  if (!user) return <Navigate to="/" replace />;
  if (!roles.includes(user.role)) return <Navigate to={user.role === "worker" ? "/worker" : "/app"} replace />;
  return <>{children}</>;
}

function MunicipalApp() {
  const { data: ov } = useOverview();
  const { data: notes } = useNotifications();
  const badges = {
    attention: ov?.metrics.pendingRequests ?? 0,
    active: ov?.metrics.activeCollections ?? 0,
    final: ov?.metrics.awaitingVerification ?? 0,
    payments: ov?.metrics.paymentsPending ?? 0,
    notifications: notes?.filter((n) => !n.read).length ?? 0,
  };
  return (
    <AppShell badges={badges}>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="map" element={<LiveMap />} />
        <Route path="requests" element={<Requests />} />
        <Route path="requests/:id" element={<RequestDetail />} />
        <Route path="assign" element={<Assign />} />
        <Route path="assign/:id" element={<Assign />} />
        <Route path="active" element={<Active />} />
        <Route path="verification" element={<Verification />} />
        <Route path="bins" element={<Bins />} />
        <Route path="bins/:id" element={<BinDetail />} />
        <Route path="workers" element={<Workers />} />
        <Route path="workers/:id" element={<WorkerProfile />} />
        <Route path="payments" element={<Payments />} />
        <Route path="audit" element={<Audit />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
    </AppShell>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route
        path="/app/*"
        element={
          <RequireRole roles={["officer", "admin"]}>
            <MunicipalApp />
          </RequireRole>
        }
      />
      <Route
        path="/worker"
        element={
          <RequireRole roles={["worker"]}>
            <WorkerApp />
          </RequireRole>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
