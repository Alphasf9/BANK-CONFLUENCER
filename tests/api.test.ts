import type { Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { DB, openDb } from "../src/db";
import { internals } from "../src/services";

let db: DB;
let app: Express;

beforeEach(() => {
  db = openDb(":memory:");
  app = createApp(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const api = () => request(app);

const tx = (accountId: number, type: string, amount: unknown, ref: unknown, extra = {}) =>
  api().post("/transactions").send({ account_id: accountId, type, amount, reference_id: ref, ...extra });

const transfer = (from: number, to: number, amount: unknown, ref: unknown = "t1") =>
  api().post("/transfers").send({ from_account_id: from, to_account_id: to, amount, reference_id: ref });

async function mkAccount(name = "Acme", balance?: number): Promise<number> {
  const r = await api().post("/accounts").send({ name });
  const id = r.body.id as number;
  if (balance) {
    const t = await tx(id, "credit", balance, `seed-${id}`);
    expect(t.status).toBe(201);
  }
  return id;
}

const balance = async (id: number): Promise<number> =>
  (await api().get(`/accounts/${id}`)).body.balance;

const code = (res: request.Response): string => res.body.error.code;

// ---------- accounts ----------
describe("accounts", () => {
  it("creates and fetches an account (name is trimmed)", async () => {
    const r = await api().post("/accounts").send({ name: "  Alice  " });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: "Alice", balance: 0 });
    const g = await api().get(`/accounts/${r.body.id}`);
    expect(g.body.name).toBe("Alice");
  });

  it("requires a name", async () => {
    for (const payload of [{}, { name: "" }, { name: "   " }, { name: 5 }, { name: "A", extra: 1 }]) {
      const r = await api().post("/accounts").send(payload);
      expect(r.status, JSON.stringify(payload)).toBe(422);
      expect(code(r)).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects malformed JSON", async () => {
    const r = await api()
      .post("/accounts")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(r.status).toBe(400);
    expect(code(r)).toBe("INVALID_REQUEST_BODY");
  });

  it("rejects a non-object body", async () => {
    const r = await api().post("/accounts").set("Content-Type", "application/json").send("[1,2]");
    expect(r.status).toBe(400);
    expect(code(r)).toBe("INVALID_REQUEST_BODY");
  });

  it("returns 404 for a missing account", async () => {
    const r = await api().get("/accounts/999");
    expect(r.status).toBe(404);
    expect(code(r)).toBe("ACCOUNT_NOT_FOUND");
  });

  it("rejects an invalid account id format", async () => {
    for (const id of ["abc", "0", "-1", "1.5"]) {
      const r = await api().get(`/accounts/${id}`);
      expect(r.status, id).toBe(422);
      expect(code(r)).toBe("VALIDATION_ERROR");
    }
  });

  it("unknown routes use the error format", async () => {
    const r = await api().get("/nope");
    expect(r.status).toBe(404);
    expect(code(r)).toBe("NOT_FOUND");
  });
});

// ---------- transactions ----------
describe("transactions", () => {
  it("credit then debit updates the balance", async () => {
    const a = await mkAccount();
    const c = await tx(a, "credit", 100, "r1");
    expect(c.status).toBe(201);
    expect(c.body.balance_after).toBe(100);
    const d = await tx(a, "debit", 40.25, "r2");
    expect(d.status).toBe(201);
    expect(d.body.balance_after).toBe(59.75);
    expect(await balance(a)).toBe(59.75);
  });

  it("404 when the account does not exist", async () => {
    const r = await tx(12345, "credit", 10, "r1");
    expect(r.status).toBe(404);
    expect(code(r)).toBe("ACCOUNT_NOT_FOUND");
  });

  it("rejects an invalid type", async () => {
    const a = await mkAccount();
    const r = await tx(a, "refund", 10, "r1");
    expect(r.status).toBe(422);
    expect(code(r)).toBe("VALIDATION_ERROR");
  });

  it("rejects invalid amounts", async () => {
    const a = await mkAccount();
    for (const bad of [0, -5, "abc", 1.005, null, "", 1e21, true]) {
      const r = await tx(a, "credit", bad, `bad-${String(bad)}`);
      expect(r.status, String(bad)).toBe(422);
    }
    expect(await balance(a)).toBe(0);
  });

  it("requires reference_id", async () => {
    const a = await mkAccount();
    const missing = await api().post("/transactions").send({ account_id: a, type: "credit", amount: 5 });
    expect(missing.status).toBe(422);
    const blank = await tx(a, "credit", 5, "   ");
    expect(blank.status).toBe(422);
  });

  it("rejects a debit larger than the balance", async () => {
    const a = await mkAccount("A", 50);
    const r = await tx(a, "debit", 50.01, "d1");
    expect(r.status).toBe(422);
    expect(code(r)).toBe("INSUFFICIENT_BALANCE");
    expect(await balance(a)).toBe(50);
    const list = await api().get(`/accounts/${a}/transactions`);
    expect(list.body.pagination.total).toBe(1); // only the seed credit
  });

  it("allows debiting the exact balance", async () => {
    const a = await mkAccount("A", 50);
    expect((await tx(a, "debit", 50, "d1")).status).toBe(201);
    expect(await balance(a)).toBe(0);
  });

  it("replaying an identical request is idempotent", async () => {
    const a = await mkAccount();
    const first = await tx(a, "credit", 10, "same");
    const second = await tx(a, "credit", 10, "same");
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(second.body.id).toBe(first.body.id);
    expect(await balance(a)).toBe(10); // applied once
  });

  it("reusing a reference_id with different data is a 409", async () => {
    const a = await mkAccount();
    await tx(a, "credit", 10, "same");
    const r = await tx(a, "credit", 99, "same");
    expect(r.status).toBe(409);
    expect(code(r)).toBe("DUPLICATE_TRANSACTION");
    expect(await balance(a)).toBe(10);
  });

  it("allows the same reference_id on different accounts", async () => {
    const a = await mkAccount("A");
    const b = await mkAccount("B");
    expect((await tx(a, "credit", 1, "shared")).status).toBe(201);
    expect((await tx(b, "credit", 1, "shared")).status).toBe(201);
  });
});

// ---------- listing / pagination ----------
describe("listing and pagination", () => {
  it("paginates (newest first) and filters by type", async () => {
    const a = await mkAccount();
    for (let i = 0; i < 5; i++) await tx(a, "credit", 10, `c${i}`);
    await tx(a, "debit", 5, "d0");
    const r = await api().get(`/accounts/${a}/transactions?page=1&limit=4`);
    expect(r.body.data).toHaveLength(4);
    expect(r.body.pagination).toEqual({ page: 1, limit: 4, total: 6, total_pages: 2 });
    expect(r.body.data[0].reference_id).toBe("d0");
    const debits = await api().get(`/accounts/${a}/transactions?type=debit`);
    expect(debits.body.pagination.total).toBe(1);
  });

  it("rejects invalid pagination parameters", async () => {
    const a = await mkAccount();
    for (const qs of ["page=0", "limit=0", "limit=101", "page=abc", "limit=-1", "limit=2.5"]) {
      const r = await api().get(`/accounts/${a}/transactions?${qs}`);
      expect(r.status, qs).toBe(400);
      expect(code(r)).toBe("INVALID_PAGINATION");
    }
    expect((await api().get("/accounts?page=0")).status).toBe(400);
  });

  it("rejects an invalid type filter", async () => {
    const a = await mkAccount();
    const r = await api().get(`/accounts/${a}/transactions?type=bogus`);
    expect(r.status).toBe(422);
  });
});

// ---------- atomicity ----------
describe("atomicity", () => {
  it("rolls back the balance change if recording the transaction fails", async () => {
    const a = await mkAccount("A", 100);
    vi.spyOn(internals, "insertTransaction").mockImplementation(() => {
      throw new Error("simulated crash while recording transaction");
    });
    const r = await tx(a, "debit", 30, "x1");
    expect(r.status).toBe(500);
    expect(code(r)).toBe("INTERNAL_ERROR");
    vi.restoreAllMocks();
    expect(await balance(a)).toBe(100); // balance change NOT persisted
    const list = await api().get(`/accounts/${a}/transactions`);
    expect(list.body.pagination.total).toBe(1);
  });

  it("parallel debits never overdraw the account", async () => {
    const a = await mkAccount("A", 100);
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => tx(a, "debit", 10, `t${i}`))
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 422 && code(r) === "INSUFFICIENT_BALANCE")).toHaveLength(15);
    expect(await balance(a)).toBe(0);
  });

  it("database constraints reject a negative balance even if the service layer is bypassed", async () => {
    const a = await mkAccount("A", 10);
    expect(() => db.prepare("UPDATE accounts SET balance = -1 WHERE id = ?").run(a)).toThrow();
  });
});

// ---------- transfers ----------
describe("transfers", () => {
  it("matches the example in the brief (A=100, B=50, move 30 -> 70 / 80)", async () => {
    const a = await mkAccount("A", 100);
    const b = await mkAccount("B", 50);
    const r = await transfer(a, b, 30);
    expect(r.status).toBe(201);
    expect(r.body.from_account.balance).toBe(70);
    expect(r.body.to_account.balance).toBe(80);
    expect(await balance(a)).toBe(70);
    expect(await balance(b)).toBe(80);
    expect(r.body.debit_transaction.transfer_id).toBe(r.body.credit_transaction.transfer_id);
    expect(r.body.debit_transaction.type).toBe("debit");
    expect(r.body.credit_transaction.type).toBe("credit");
  });

  it("fails with insufficient balance and changes nothing", async () => {
    const a = await mkAccount("A", 10);
    const b = await mkAccount("B", 0);
    const r = await transfer(a, b, 30);
    expect(r.status).toBe(422);
    expect(code(r)).toBe("INSUFFICIENT_BALANCE");
    expect(await balance(a)).toBe(10);
    expect(await balance(b)).toBe(0);
  });

  it("requires both accounts to exist", async () => {
    const a = await mkAccount("A", 10);
    expect((await transfer(a, 999, 5)).status).toBe(404);
    expect((await transfer(999, a, 5)).status).toBe(404);
    expect(await balance(a)).toBe(10);
  });

  it("rejects transferring to the same account", async () => {
    const a = await mkAccount("A", 10);
    const r = await transfer(a, a, 5);
    expect(r.status).toBe(422);
    expect(code(r)).toBe("INVALID_TRANSFER");
  });

  it("validates input", async () => {
    const a = await mkAccount("A", 10);
    const b = await mkAccount("B");
    expect((await transfer(a, b, 0)).status).toBe(422);
    expect((await transfer(a, b, -1)).status).toBe(422);
    expect((await transfer(a, b, 5, " ")).status).toBe(422);
  });

  it("rejects a duplicate reference_id", async () => {
    const a = await mkAccount("A", 100);
    const b = await mkAccount("B");
    expect((await transfer(a, b, 10, "dup")).status).toBe(201);
    const r = await transfer(a, b, 10, "dup");
    expect(r.status).toBe(409);
    expect(code(r)).toBe("DUPLICATE_TRANSACTION");
    expect(await balance(a)).toBe(90);
    expect(await balance(b)).toBe(10);
  });

  it("rolls back BOTH legs if the credit leg fails (no partial transfer)", async () => {
    const a = await mkAccount("A", 100);
    const b = await mkAccount("B", 50);
    const real = internals.insertTransaction;
    let calls = 0;
    vi.spyOn(internals, "insertTransaction").mockImplementation((...args) => {
      calls += 1;
      if (calls === 2) throw new Error("simulated failure on the credit leg");
      return real(...args);
    });
    const r = await transfer(a, b, 30);
    vi.restoreAllMocks();
    expect(r.status).toBe(500);
    expect(await balance(a)).toBe(100);
    expect(await balance(b)).toBe(50);
    expect((await api().get(`/accounts/${a}/transactions`)).body.pagination.total).toBe(1);
    expect((await api().get(`/accounts/${b}/transactions`)).body.pagination.total).toBe(1);
  });
});
