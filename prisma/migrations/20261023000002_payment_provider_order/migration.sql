-- Payment provider correlation id: lets a webhook find the payment by the
-- gateway's own order id, and makes "same gateway order processed twice"
-- impossible.
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "providerOrderId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Payment_provider_providerOrderId_key"
  ON "Payment" ("provider", "providerOrderId");
