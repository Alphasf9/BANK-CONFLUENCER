import { z } from "zod";
import { AppError } from "./errors";

/** Convert a rupee/dollar amount (number or numeric string) to integer minor units, or null if invalid. */
export function toMinor(v: number | string): number | null {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v.trim();
  // up to 12 integer digits, at most 2 decimals, no exponent / sign
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return minor > 0 ? minor : null;
}

export const fromMinor = (minor: number): number => minor / 100;

// NOTE: after parsing, `amount` is already converted to integer minor units.
const amountField = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const minor = toMinor(v);
  if (minor === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be a number greater than 0 with at most 2 decimal places",
    });
    return z.NEVER;
  }
  return minor;
});

const referenceId = z.string().trim().min(1, "must not be empty").max(100);
const description = z.string().max(255).nullish();

export const accountCreateSchema = z
  .object({ name: z.string().trim().min(1, "must not be empty").max(100) })
  .strict();

export const transactionCreateSchema = z
  .object({
    account_id: z.number().int().min(1),
    type: z.enum(["credit", "debit"]),
    amount: amountField,
    reference_id: referenceId,
    description,
  })
  .strict();

export const transferCreateSchema = z
  .object({
    from_account_id: z.number().int().min(1),
    to_account_id: z.number().int().min(1),
    amount: amountField,
    reference_id: referenceId,
    description,
  })
  .strict();

export type TxType = "credit" | "debit";

/** Parse with a zod schema; throws a 422 AppError in the standard error format. */
export function parseBody<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(
      422,
      "VALIDATION_ERROR",
      "Request validation failed",
      result.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }))
    );
  }
  return result.data;
}
