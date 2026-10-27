/**
 * Business logic. Every write runs inside `db.transaction(...).immediate()`
 * (BEGIN IMMEDIATE ... COMMIT). If anything throws, better-sqlite3 issues a
 * ROLLBACK and rethrows, so a ledger row and its balance update (and both legs
 * of a transfer) are persisted together or not at all.
 *
 * BEGIN IMMEDIATE takes SQLite's write lock up front, so writers (even from
 * several processes) are serialised and a balance check can never race with
 * another debit.
 */
import { randomUUID } from "crypto";
import type { DB } from "./db";
import { AppError } from "./errors";
import { fromMinor, TxType } from "./schemas";

interface AccountRow {
  id: number;
  name: string;
  balance: number;
  created_at: string;
}
interface TxRow {
  id: number;
  account_id: number;
  type: TxType;
  amount: number;
  reference_id: string;
  description: string | null;
  balance_after: number;
  transfer_id: string | null;
  created_at: string;
}

// ---------- mappers ----------
export const accountDto = (r: AccountRow) => ({
  id: r.id,
  name: r.name,
  balance: fromMinor(r.balance),
  created_at: r.created_at,
});

export const txDto = (r: TxRow) => ({
  id: r.id,
  account_id: r.account_id,
  type: r.type,
  amount: fromMinor(r.amount),
  reference_id: r.reference_id,
  description: r.description,
  balance_after: fromMinor(r.balance_after),
  transfer_id: r.transfer_id,
  created_at: r.created_at,
});

const pagination = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  total_pages: total === 0 ? 0 : Math.ceil(total / limit),
});

// ---------- helpers ----------
function requireAccount(db: DB, id: number): AccountRow {
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
  if (!row) throw new AppError(404, "ACCOUNT_NOT_FOUND", `Account ${id} not found`);
  return row;
}

const getTx = (db: DB, id: number | bigint) =>
  db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as TxRow;

/** Low-level insert. Exposed via `internals` so tests can simulate a crash mid-operation. */
function insertTransaction(
  db: DB,
  accountId: number,
  type: TxType,
  minor: number,
  referenceId: string,
  description: string | null,
  balanceAfter: number,
  transferId: string | null
): number | bigint {
  try {
    const info = db
      .prepare(
        `INSERT INTO transactions
           (account_id, type, amount, reference_id, description, balance_after, transfer_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(accountId, type, minor, referenceId, description, balanceAfter, transferId);
    return info.lastInsertRowid;
  } catch (e) {
    if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new AppError(
        409,
        "DUPLICATE_TRANSACTION",
        `reference_id '${referenceId}' already used for account ${accountId}`
      );
    }
    throw e;
  }
}

export const internals = { insertTransaction };

/** Update the balance, then record the ledger row. Must be called inside a transaction. */
function postEntry(
  db: DB,
  accountId: number,
  type: TxType,
  minor: number,
  referenceId: string,
  description: string | null,
  transferId: string | null = null
): number | bigint {
  if (type === "credit") {
    db.prepare("UPDATE accounts SET balance = balance + ? WHERE id = ?").run(minor, accountId);
  } else {
    // Guarded UPDATE: the balance check and the deduction are one atomic statement.
    const res = db
      .prepare("UPDATE accounts SET balance = balance - ? WHERE id = ? AND balance >= ?")
      .run(minor, accountId, minor);
    if (res.changes === 0) {
      const { balance } = db
        .prepare("SELECT balance FROM accounts WHERE id = ?")
        .get(accountId) as { balance: number };
      throw new AppError(
        422,
        "INSUFFICIENT_BALANCE",
        `Account ${accountId} has insufficient balance for this debit`,
        [{ available: fromMinor(balance), requested: fromMinor(minor) }]
      );
    }
  }
  const { balance: balanceAfter } = db
    .prepare("SELECT balance FROM accounts WHERE id = ?")
    .get(accountId) as { balance: number };
  return internals.insertTransaction(
    db,
    accountId,
    type,
    minor,
    referenceId,
    description,
    balanceAfter,
    transferId
  );
}

// ---------- accounts ----------
export function createAccount(db: DB, name: string) {
  return db.transaction(() => {
    const info = db.prepare("INSERT INTO accounts (name) VALUES (?)").run(name);
    return accountDto(requireAccount(db, Number(info.lastInsertRowid)));
  }).immediate();
}

export function getAccount(db: DB, id: number) {
  return accountDto(requireAccount(db, id));
}

export function listAccounts(db: DB, page: number, limit: number) {
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM accounts").get() as { c: number };
  const rows = db
    .prepare("SELECT * FROM accounts ORDER BY id LIMIT ? OFFSET ?")
    .all(limit, (page - 1) * limit) as AccountRow[];
  return { data: rows.map(accountDto), pagination: pagination(page, limit, c) };
}

export function listTransactions(
  db: DB,
  accountId: number,
  page: number,
  limit: number,
  type?: TxType
) {
  requireAccount(db, accountId);
  const where = type ? "account_id = ? AND type = ?" : "account_id = ?";
  const params: (number | string)[] = type ? [accountId, type] : [accountId];
  const { c } = db
    .prepare(`SELECT COUNT(*) AS c FROM transactions WHERE ${where}`)
    .get(...params) as { c: number };
  const rows = db
    .prepare(`SELECT * FROM transactions WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, (page - 1) * limit) as TxRow[];
  return { data: rows.map(txDto), pagination: pagination(page, limit, c) };
}

// ---------- transactions ----------
/**
 * Idempotent on (account_id, reference_id): replaying the *same* request returns the
 * original transaction (created = false); reusing the reference_id with different data
 * is a 409 conflict.
 */
export function createTransaction(
  db: DB,
  input: {
    accountId: number;
    type: TxType;
    minor: number;
    referenceId: string;
    description: string | null;
  }
) {
  return db
    .transaction(() => {
      requireAccount(db, input.accountId);
      const existing = db
        .prepare("SELECT * FROM transactions WHERE account_id = ? AND reference_id = ?")
        .get(input.accountId, input.referenceId) as TxRow | undefined;
      if (existing) {
        if (existing.type === input.type && existing.amount === input.minor) {
          return { tx: txDto(existing), created: false };
        }
        throw new AppError(
          409,
          "DUPLICATE_TRANSACTION",
          `reference_id '${input.referenceId}' was already used for account ${input.accountId} with different details`
        );
      }
      const id = postEntry(
        db,
        input.accountId,
        input.type,
        input.minor,
        input.referenceId,
        input.description
      );
      return { tx: txDto(getTx(db, id)), created: true };
    })
    .immediate();
}

// ---------- transfers ----------
export function transfer(
  db: DB,
  input: {
    fromId: number;
    toId: number;
    minor: number;
    referenceId: string;
    description: string | null;
  }
) {
  if (input.fromId === input.toId) {
    throw new AppError(422, "INVALID_TRANSFER", "Source and destination accounts must differ");
  }
  return db
    .transaction(() => {
      requireAccount(db, input.fromId);
      requireAccount(db, input.toId);
      for (const acc of [input.fromId, input.toId]) {
        const dup = db
          .prepare("SELECT 1 FROM transactions WHERE account_id = ? AND reference_id = ?")
          .get(acc, input.referenceId);
        if (dup) {
          throw new AppError(
            409,
            "DUPLICATE_TRANSACTION",
            `reference_id '${input.referenceId}' already used for account ${acc}`
          );
        }
      }
      const transferId = randomUUID().replace(/-/g, "");
      const desc = input.description ?? "Transfer";
      const debitId = postEntry(
        db,
        input.fromId,
        "debit",
        input.minor,
        input.referenceId,
        `${desc} (to account ${input.toId})`,
        transferId
      );
      const creditId = postEntry(
        db,
        input.toId,
        "credit",
        input.minor,
        input.referenceId,
        `${desc} (from account ${input.fromId})`,
        transferId
      );
      return {
        transfer_id: transferId,
        reference_id: input.referenceId,
        amount: fromMinor(input.minor),
        from_account: accountDto(requireAccount(db, input.fromId)),
        to_account: accountDto(requireAccount(db, input.toId)),
        debit_transaction: txDto(getTx(db, debitId)),
        credit_transaction: txDto(getTx(db, creditId)),
      };
    })
    .immediate();
}
