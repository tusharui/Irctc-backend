
const SQLSTATE = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  exclusionViolation: "23P01",
} as const;

type MaybeError = {
  code?: unknown;
  message?: unknown;
  meta?: { code?: unknown; message?: unknown; cause?: unknown } | null;
};

function text(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const m = (err as MaybeError | null)?.message;
  return typeof m === "string" ? m : "";
}

function sqlState(err: unknown): string | undefined {
  const e = err as MaybeError | null;
  if (!e) return undefined;

  // Prisma sometimes exposes the raw code under meta.code.
  const metaCode = e.meta?.code;
  if (typeof metaCode === "string") return metaCode;

  const message = text(err);
  // Driver adapters embed "Code: `23505`" / "SQLSTATE 23505".
  const match = message.match(/Code:\s*`?([0-9A-Z]{5})`?/) ?? message.match(/SQLSTATE\s+([0-9A-Z]{5})/);
  return match?.[1];
}

/** A unique index rejected the write (duplicate key). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as MaybeError | null;
  if (e?.code === "P2002") return true;
  return sqlState(err) === SQLSTATE.uniqueViolation;
}

/**
 * An EXCLUDE constraint rejected the write.
 *
 * This is the one that fires when two reservations try to occupy overlapping
 * segments of the same seat — the booking race, caught by Postgres.
 */
export function isExclusionViolation(err: unknown): boolean {
  const state = sqlState(err);
  if (state === SQLSTATE.exclusionViolation) return true;
  // Some adapter versions drop the SQLSTATE but keep the constraint name.
  return text(err).includes("TicketSeat_no_segment_overlap");
}

/** A CHECK constraint rejected the write (bad range, negative money, ...). */
export function isCheckViolation(err: unknown): boolean {
  return sqlState(err) === SQLSTATE.checkViolation;
}

/** A foreign key rejected the write (referenced row missing / cross-entity). */
export function isForeignKeyViolation(err: unknown): boolean {
  const e = err as MaybeError | null;
  if (e?.code === "P2003") return true;
  return sqlState(err) === SQLSTATE.foreignKeyViolation;
}

/**
 * The name of the constraint that failed, when the driver reports it.
 * Useful for turning "some constraint failed" into a precise 409 message.
 */
export function failedConstraintName(err: unknown): string | undefined {
  const message = text(err);
  return (
    message.match(/constraint "([^"]+)"/)?.[1] ??
    message.match(/violates exclusion constraint "([^"]+)"/)?.[1]
  );
}

/** True for any constraint the schema is designed to enforce. */
export function isIntegrityViolation(err: unknown): boolean {
  return (
    isUniqueViolation(err) ||
    isExclusionViolation(err) ||
    isCheckViolation(err) ||
    isForeignKeyViolation(err)
  );
}
