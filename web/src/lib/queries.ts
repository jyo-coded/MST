import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useSession } from "./store";
import type {
  BinDetail,
  Bin,
  Candidate,
  ChainStatus,
  Config,
  Health,
  MeJob,
  Notification,
  Overview,
  PaymentsView,
  Request,
  RequestDetail,
  SimSnapshot,
  Tx,
  Verification,
  Worker,
  WorkerDetail,
} from "./types";

const authed = () => !!useSession.getState().token;

export const useConfig = () => useQuery({ queryKey: ["config"], queryFn: () => api<Config>("/system/config"), staleTime: 30_000 });
export const useHealth = () => useQuery({ queryKey: ["health"], queryFn: () => api<Health>("/system/health"), refetchInterval: 10_000 });
export const useOverview = () => useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/overview"), enabled: authed() });
export const useBins = () => useQuery({ queryKey: ["bins"], queryFn: () => api<Bin[]>("/bins"), enabled: authed() });
export const useBin = (id?: string, minutes = 30) =>
  useQuery({ queryKey: ["bin", id, minutes], queryFn: () => api<BinDetail>(`/bins/${id}?minutes=${minutes}`), enabled: !!id && authed() });
export const useWorkers = () => useQuery({ queryKey: ["workers"], queryFn: () => api<Worker[]>("/workers"), enabled: authed() });
export const useWorker = (id?: string) => useQuery({ queryKey: ["worker", id], queryFn: () => api<WorkerDetail>(`/workers/${id}`), enabled: !!id && authed() });
export const useRequests = (group = "") =>
  useQuery({ queryKey: ["requests", group], queryFn: () => api<Request[]>(`/requests${group ? `?group=${group}` : ""}`), enabled: authed() });
export const useRequest = (id?: number | null) =>
  useQuery({ queryKey: ["request", id], queryFn: () => api<RequestDetail>(`/requests/${id}`), enabled: !!id && authed() });
export const useCandidates = (id?: number | null) =>
  useQuery({ queryKey: ["candidates", id], queryFn: () => api<Candidate[]>(`/requests/${id}/candidates`), enabled: !!id && authed() });
export const useVerifications = (kind = "") =>
  useQuery({ queryKey: ["verifications", kind], queryFn: () => api<Verification[]>(`/verifications${kind ? `?kind=${kind}` : ""}`), enabled: authed() });
export const usePayments = () => useQuery({ queryKey: ["payments"], queryFn: () => api<PaymentsView>("/payments"), enabled: authed() });
export const useChainStatus = () => useQuery({ queryKey: ["chain-status"], queryFn: () => api<ChainStatus>("/chain/status"), enabled: authed(), refetchInterval: 15_000 });
export const useTxs = (filters: { action?: string; status?: string; requestId?: number } = {}) => {
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== undefined && v !== "") as [string, string][]).toString();
  return useQuery({ queryKey: ["txs", qs], queryFn: () => api<Tx[]>(`/chain/transactions${qs ? `?${qs}` : ""}`), enabled: authed() });
};
export const useTx = (hash?: string | null) => useQuery({ queryKey: ["tx", hash], queryFn: () => api<Tx>(`/chain/transactions/${hash}`), enabled: !!hash && authed() });
export const useNotifications = () => useQuery({ queryKey: ["notifications"], queryFn: () => api<Notification[]>("/notifications"), enabled: authed() });
export const useSim = () => useQuery({ queryKey: ["sim"], queryFn: () => api<SimSnapshot>("/sim"), enabled: authed(), refetchInterval: 5000 });
export const useMeJob = () => useQuery({ queryKey: ["me-job"], queryFn: () => api<MeJob>("/me/job"), enabled: authed(), refetchInterval: 8000 });

/** Active collections = requests between assignment and final approval. */
export const useActive = () =>
  useQuery({ queryKey: ["active"], queryFn: () => api<Request[]>("/requests?group=active"), enabled: authed() });

export const useForecast = (binId?: string) =>
  useQuery({ queryKey: ["forecast", binId], queryFn: () => api<any>(`/bins/${binId}/forecast`), enabled: !!binId });

export const useChallenges = () =>
  useQuery({ queryKey: ["challenges"], queryFn: () => api<any[]>("/challenges"), refetchInterval: 5000 });

export const useWatcherStatus = () =>
  useQuery({ queryKey: ["watcher-status"], queryFn: () => api<any>("/watcher/status"), refetchInterval: 4000 });

export const useAuditBundle = (hashOrId?: string) =>
  useQuery({
    queryKey: ["audit-bundle", hashOrId],
    queryFn: () => api<any>(`/audit/bundle/${hashOrId}`),
    enabled: !!hashOrId,
    retry: false,
  });

export const useAuditSamples = () =>
  useQuery({ queryKey: ["audit-samples"], queryFn: () => api<any[]>("/audit/samples") });

export const useTransferStationConfig = () =>
  useQuery({ queryKey: ["transfer-station-config"], queryFn: () => api<any>("/transfer-station/config") });

