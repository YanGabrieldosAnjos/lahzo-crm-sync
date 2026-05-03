import type { HubSpotContact } from "@lahzo/shared";
import type { Db } from "../db/client.js";
import { schema } from "../db/client.js";
import { TokenBucket } from "./limiter.js";
import { backoffMs, parseRetryAfterMs, sleep } from "./backoff.js";

const HUBSPOT_API = "https://api.hubapi.com";

// Properties we always request so the worker has what it needs.
const CONTACT_PROPERTIES = [
  "email",
  "firstname",
  "lastname",
  "lahzo_score",
  "lahzo_status",
  "lastmodifieddate",
].join(",");

export class HubSpotError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "HubSpotError";
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text; // return raw string rather than crashing the audit insert
  }
}

export class HubSpotClient {
  constructor(
    private readonly token: string,
    private readonly db: Db,
    private readonly limiter: TokenBucket,
    private readonly opts: { maxAttempts: number },
  ) {}

  async getContact(crmId: string, contactId?: string): Promise<HubSpotContact> {
    const url = `${HUBSPOT_API}/crm/v3/objects/contacts/${crmId}?properties=${CONTACT_PROPERTIES}`;
    return this.request<HubSpotContact>(url, "GET", undefined, contactId);
  }

  async updateContactProperties(
    crmId: string,
    props: Record<string, string>,
    contactId: string,
  ): Promise<void> {
    const url = `${HUBSPOT_API}/crm/v3/objects/contacts/${crmId}`;
    await this.request(url, "PATCH", { properties: props }, contactId);
  }

  private async request<T>(
    url: string,
    method: "GET" | "PATCH",
    body?: Record<string, unknown>,
    contactId?: string,
  ): Promise<T> {
    let attempt = 0;

    while (attempt < this.opts.maxAttempts) {
      attempt++;
      await this.limiter.take();

      const t0 = Date.now();
      let responseStatus: number | null = null;
      let responseBody: unknown = null;
      let errorMsg: string | null = null;
      let retryAfterHeader: string | null = null;

      try {
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        responseStatus = res.status;
        retryAfterHeader = res.headers.get("Retry-After");
        const text = await res.text();
        responseBody = text ? safeJsonParse(text) : null;
      } catch (err) {
        // Network-level failure: DNS, connection refused, timeout, etc.
        errorMsg = (err as Error).message;
      }

      const latencyMs = Date.now() - t0;

      // Audit log — one row per attempt, always, regardless of outcome.
      await this.db.insert(schema.apiCalls).values({
        contactId: contactId ?? null,
        method,
        url,
        requestBody: body ?? null,
        responseStatus,
        responseBody,
        attempt,
        latencyMs,
        error: errorMsg,
      });

      // Success
      if (responseStatus !== null && responseStatus >= 200 && responseStatus < 300) {
        return responseBody as T;
      }

      const isNetworkError = errorMsg !== null;
      const isRetryable =
        isNetworkError || responseStatus === 429 || (responseStatus ?? 0) >= 500;

      if (!isRetryable) {
        // 4xx (non-429): caller error, no point retrying
        throw new HubSpotError(
          `HubSpot ${method} ${url} failed with ${responseStatus}`,
          responseStatus,
          responseBody,
        );
      }

      if (attempt >= this.opts.maxAttempts) break;

      // Compute how long to wait before the next attempt
      const waitMs =
        responseStatus === 429
          ? (parseRetryAfterMs(retryAfterHeader) ?? backoffMs(attempt))
          : backoffMs(attempt);

      await sleep(waitMs);
    }

    throw new HubSpotError(
      `HubSpot ${method} ${url} failed after ${this.opts.maxAttempts} attempts`,
      null,
      null,
    );
  }
}

export function createHubSpotClient(db: Db): HubSpotClient {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN is required");

  const capacity = Number(process.env.HUBSPOT_RATE_LIMIT_PER_10S ?? 100);
  const limiter = new TokenBucket(capacity, 10_000);

  const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? 5);

  return new HubSpotClient(token, db, limiter, { maxAttempts });
}
