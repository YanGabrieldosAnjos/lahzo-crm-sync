import crypto from "crypto";

const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000; // 5 minutes — HubSpot's replay window

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureError";
  }
}

/**
 * Verifies the X-HubSpot-Signature-v3 header.
 *
 * Algorithm:
 *   HMAC-SHA256(secret, method + fullUrl + rawBody + timestamp) → base64
 *
 * Throws SignatureError if:
 *   - Any required header is missing
 *   - The timestamp is older than 5 minutes (replay protection)
 *   - The computed HMAC doesn't match the header value
 */
export function verifyHubSpotSignature(
  method: string,
  fullUrl: string,
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
  secret: string,
): void {
  if (!signature) {
    throw new SignatureError("Missing X-HubSpot-Signature-v3 header");
  }

  if (!timestamp) {
    throw new SignatureError("Missing X-HubSpot-Request-Timestamp header");
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    throw new SignatureError("Invalid X-HubSpot-Request-Timestamp header");
  }

  const age = Date.now() - ts;
  if (age > MAX_TIMESTAMP_AGE_MS || age < -MAX_TIMESTAMP_AGE_MS) {
    throw new SignatureError(
      `Request timestamp is too old or too far in the future (age: ${age}ms)`,
    );
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(method + fullUrl + rawBody + timestamp)
    .digest("base64");

  // timingSafeEqual prevents timing-based attacks on the comparison.
  // Buffers must be the same byte length — pad/truncate to expected length.
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);

  if (
    sigBuf.length !== expBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expBuf)
  ) {
    throw new SignatureError("Signature mismatch");
  }
}
