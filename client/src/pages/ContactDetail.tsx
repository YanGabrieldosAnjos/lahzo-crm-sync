import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ContactDetail as ContactDetailType, SyncStatus, TimelineItem } from "@lahzo/shared";
import { getContact, resyncContact } from "../api";

function StatusBadge({ status }: { status: SyncStatus }) {
  return <span className={`badge badge-${status}`}>{status.replace("_", " ")}</span>;
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const isEvent = item.kind === "event";
  const timestamp = new Date(item.at).toLocaleString();

  if (isEvent) {
    const e = item.event;
    return (
      <tr>
        <td><span className="timeline-kind event">inbound</span></td>
        <td className="mono">{timestamp}</td>
        <td>{e.eventType}</td>
        <td className="text-muted">event #{e.eventId}</td>
        <td>—</td>
      </tr>
    );
  }

  const c = item.call;
  const ok = c.responseStatus !== null && c.responseStatus >= 200 && c.responseStatus < 300;
  return (
    <tr>
      <td><span className="timeline-kind api_call">outbound</span></td>
      <td className="mono">{timestamp}</td>
      <td className="mono">{c.method} {new URL(c.url).pathname}</td>
      <td>
        <span style={{ color: ok ? "#15803d" : "#b91c1c", fontWeight: 600 }}>
          {c.responseStatus ?? "network error"}
        </span>
        {" "}
        <span className="text-muted">attempt {c.attempt} · {c.latencyMs}ms</span>
      </td>
      <td className="error-text">{c.error ?? "—"}</td>
    </tr>
  );
}

export default function ContactDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ContactDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load() {
    try {
      const res = await getContact(id!);
      setData(res);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 3_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleResync() {
    if (!id) return;
    setResyncing(true);
    try {
      await resyncContact(id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setResyncing(false);
    }
  }

  if (!data && !error) return <div className="container"><p className="text-muted">Loading…</p></div>;
  if (error && !data) return <div className="container"><p className="error-text">{error}</p></div>;

  const { contact, timeline } = data!;
  const displayName = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Unknown";

  return (
    <div className="container">
      <Link to="/" className="back-link">← All contacts</Link>

      {/* Contact header */}
      <div className="card">
        <div className="contact-header">
          <div>
            <div className="contact-name">{displayName}</div>
            <div className="text-muted">{contact.email ?? "no email"}</div>
            <div className="contact-meta">
              <span><strong>Status</strong> <StatusBadge status={contact.status} /></span>
              <span><strong>Score</strong> {contact.score !== null ? contact.score.toFixed(1) : "—"}</span>
              <span><strong>CRM</strong> {contact.crmSource} #{contact.crmId}</span>
              <span><strong>Last event</strong> {new Date(contact.lastEventAt).toLocaleString()}</span>
            </div>
            {contact.lastError && (
              <div className="error-text" style={{ marginTop: 8 }}>
                Last error: {contact.lastError}
              </div>
            )}
          </div>
          <button
            className="btn-primary"
            onClick={handleResync}
            disabled={resyncing || contact.status === "processing"}
          >
            {resyncing ? "Queuing…" : "Resync"}
          </button>
        </div>
      </div>

      {/* Timeline */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #e0e0e0", fontWeight: 600, fontSize: 13 }}>
          Timeline ({timeline.length} events)
        </div>
        <table>
          <thead>
            <tr>
              <th>Direction</th>
              <th>Time</th>
              <th>Type / Endpoint</th>
              <th>Result</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {timeline.length === 0 && (
              <tr><td colSpan={5} className="empty">No events yet.</td></tr>
            )}
            {timeline.map((item, i) => (
              <TimelineRow key={i} item={item} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
