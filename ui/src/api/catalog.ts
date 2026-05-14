import type {
  AssetListItem,
  AssetManifest,
  CatalogStats,
  InstallResult,
} from "./types.ts";

const API_BASE = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "/catalog";

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(body.error ?? res.statusText), {
      status: res.status,
      body,
    });
  }
  return res.json() as Promise<T>;
}

export interface ListParams {
  q?: string;
  domain?: string;
  skill?: string;
  sensitivity?: string;
  page?: number;
  pageSize?: number;
}

export async function listAssets(
  params: ListParams = {}
): Promise<{ total: number; page: number; pageSize: number; assets: AssetListItem[] }> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.domain) qs.set("domain", params.domain);
  if (params.skill) qs.set("skill", params.skill);
  if (params.sensitivity) qs.set("sensitivity", params.sensitivity);
  if (typeof params.page === "number") qs.set("page", String(params.page));
  if (typeof params.pageSize === "number") qs.set("pageSize", String(params.pageSize));

  return fetchJson(`${API_BASE}/assets${qs.size ? `?${qs}` : ""}`);
}

export async function getAssetVersions(
  name: string
): Promise<{ name: string; versions: string[] }> {
  return fetchJson(`${API_BASE}/assets/${encodeURIComponent(name)}/versions`);
}

export async function getAssetManifest(
  name: string,
  version: string
): Promise<AssetManifest> {
  return fetchJson(
    `${API_BASE}/assets/${encodeURIComponent(name)}/${version}/manifest`
  );
}

export async function installAsset(
  name: string,
  version: string,
  target: string
): Promise<InstallResult> {
  return fetchJson(
    `${API_BASE}/assets/${encodeURIComponent(name)}/${version}/install`,
    {
      method: "POST",
      body: JSON.stringify({ target }),
    }
  );
}

export async function requestAccess(
  name: string,
  version: string,
  justification: string
): Promise<{ requestId: string; status: "submitted"; approvalChain: string[] }> {
  return fetchJson(
    `${API_BASE}/assets/${encodeURIComponent(name)}/${version}/request-access`,
    { method: "POST", body: JSON.stringify({ justification }) }
  );
}

export async function getCatalogStats(): Promise<CatalogStats> {
  return fetchJson(`${API_BASE}/stats`);
}
