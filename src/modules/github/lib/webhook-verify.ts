import crypto from "crypto";

export function verifyGitHubWebhookSignature(
  payload: string,
  signature: string | null,
  secret: string | undefined
): boolean {
  if (!signature || !secret) {
    return false;
  }

  try {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(payload);
    const expectedSignature = `sha256=${hmac.digest("hex")}`;

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}
