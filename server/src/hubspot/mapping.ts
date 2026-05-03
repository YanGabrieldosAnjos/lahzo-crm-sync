import type { Contact, HubSpotContact, SyncStatus } from "@lahzo/shared";

/**
 * Fields we can derive purely from a HubSpot contact response.
 * Deliberately excludes our internal `id`, `createdAt`, `updatedAt`,
 * `status`, `score`, and `lastError` — those are owned by our service,
 * not by HubSpot.
 */
export type HubSpotContactFields = Pick<
  Contact,
  "crmId" | "crmSource" | "email" | "firstName" | "lastName"
>;

export class Mapping {
  /**
   * HubSpot response → fields our service controls locally.
   * Used by the worker when it fetches the contact to check current state.
   */
  mapFromHubSpot(raw: HubSpotContact): HubSpotContactFields {
    return {
      crmSource: "hubspot",
      crmId: raw.id,
      email: raw.properties.email ?? null,
      firstName: raw.properties.firstname ?? null,
      lastName: raw.properties.lastname ?? null,
    };
  }

  /**
   * Our computed values → HubSpot PATCH body.
   * Used by the worker when writing back score + status.
   */
  mapToHubSpotProperties(
    score: number,
    status: SyncStatus,
  ): Pick<HubSpotContact["properties"], "lahzo_score" | "lahzo_status"> {
    return {
      lahzo_score: score.toString(),
      lahzo_status: status,
    };
  }
}
