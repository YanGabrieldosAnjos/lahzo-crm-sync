import type { ContactListResponse, ContactDetail } from "@lahzo/shared";

const BASE = "/api";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${path}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export function getContacts(params?: {
  status?: string;
  limit?: number;
  cursor?: string;
}): Promise<ContactListResponse> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  const query = qs.toString();
  return apiFetch(`/contacts${query ? `?${query}` : ""}`);
}

export function getContact(id: string): Promise<ContactDetail> {
  return apiFetch(`/contacts/${id}`);
}

export function resyncContact(id: string): Promise<{ message: string }> {
  return apiFetch(`/contacts/${id}/resync`, { method: "POST" });
}
