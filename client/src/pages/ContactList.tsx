import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ContactListItem, SyncStatus } from "@lahzo/shared";
import { getContacts } from "../api";

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "received", label: "Received" },
  { value: "processing", label: "Processing" },
  { value: "synced", label: "Synced" },
  { value: "failed", label: "Failed" },
  { value: "skipped_stale", label: "Skipped (stale)" },
];

function StatusBadge({ status }: { status: SyncStatus }) {
  return <span className={`badge badge-${status}`}>{status.replace("_", " ")}</span>;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function ContactList() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ContactListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load(cursor?: string) {
    try {
      const res = await getContacts({ status: status || undefined, cursor });
      setItems((prev) => (cursor ? [...prev, ...res.items] : res.items));
      setNextCursor(res.nextCursor);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Initial load + poll every 3s
  useEffect(() => {
    setLoading(true);
    setItems([]);
    load();
    intervalRef.current = setInterval(() => load(), 3_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <div className="container">
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <span className="text-muted">Auto-refreshes every 3s</span>
      </div>

      {error && <div className="card error-text">{error}</div>}

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Contact</th>
              <th>Status</th>
              <th>Score</th>
              <th>Last event</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 && (
              <tr><td colSpan={5} className="empty">Loading…</td></tr>
            )}
            {!loading && items.length === 0 && (
              <tr><td colSpan={5} className="empty">No contacts yet. Create one in HubSpot.</td></tr>
            )}
            {items.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => navigate(`/contacts/${c.id}`)}>
                <td>
                  <div>{c.firstName || c.lastName ? `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() : "—"}</div>
                  <div className="text-muted">{c.email ?? "no email"}</div>
                </td>
                <td><StatusBadge status={c.status} /></td>
                <td>{c.score !== null ? c.score.toFixed(1) : "—"}</td>
                <td className="text-muted">{relativeTime(c.lastEventAt)}</td>
                <td className="error-text" title={c.lastError ?? ""}>{c.lastError ? c.lastError.slice(0, 60) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {nextCursor && (
        <div className="load-more">
          <button className="btn-secondary" onClick={() => load(nextCursor)}>Load more</button>
        </div>
      )}
    </div>
  );
}
