
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-webhook-signature";

export function signWebhook(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export function verifyWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) return false;

  const provided = signature.trim().replace(/^sha256=/i, "").toLowerCase();
  if (provided.length === 0) return false;

  const expected = signWebhook(payload, secret);

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");

  // timingSafeEqual throws on a length mismatch, so check that first. Length
  // is not secret.
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}
