import express, { Express, NextFunction, Request, Response } from "express";
import type { DB } from "./db";
import { AppError, errorHandler, notFoundHandler } from "./errors";
import {
  accountCreateSchema,
  parseBody,
  transactionCreateSchema,
  transferCreateSchema,
  TxType,
} from "./schemas";
import * as svc from "./services";

function parseId(raw: string): number {
  if (!/^\d{1,15}$/.test(raw) || Number(raw) < 1) {
    throw new AppError(422, "VALIDATION_ERROR", "Request validation failed", [
      { field: "id", message: "must be a positive integer" },
    ]);
  }
  return Number(raw);
}

function parsePagination(q: Request["query"]): { page: number; limit: number } {
  const read = (key: "page" | "limit", fallback: number): number => {
    const v = q[key];
    if (v === undefined) return fallback;
    if (typeof v !== "string" || !/^-?\d+$/.test(v)) {
      throw new AppError(400, "INVALID_PAGINATION", `${key} must be an integer`, [
        { field: key, message: "must be an integer" },
      ]);
    }
    return Number(v);
  };
  const page = read("page", 1);
  const limit = read("limit", 20);
  if (page < 1 || limit < 1 || limit > 100) {
    throw new AppError(
      400,
      "INVALID_PAGINATION",
      "page must be >= 1 and limit must be between 1 and 100",
      [{ field: page < 1 ? "page" : "limit", message: "out of range" }]
    );
  }
  return { page, limit };
}

function parseTypeFilter(q: Request["query"]): TxType | undefined {
  const v = q.type;
  if (v === undefined) return undefined;
  if (v === "credit" || v === "debit") return v;
  throw new AppError(422, "VALIDATION_ERROR", "Request validation failed", [
    { field: "type", message: "must be 'credit' or 'debit'" },
  ]);
}

export function createApp(db: DB): Express {
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  // Body of a write request must be a JSON object.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      const b = req.body;
      if (typeof b !== "object" || b === null || Array.isArray(b)) {
        return next(
          new AppError(400, "INVALID_REQUEST_BODY", "Request body must be a JSON object")
        );
      }
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // ---------- accounts ----------
  app.post("/accounts", (req, res) => {
    const body = parseBody(accountCreateSchema, req.body);
    res.status(201).json(svc.createAccount(db, body.name));
  });

  app.get("/accounts", (req, res) => {
    const { page, limit } = parsePagination(req.query);
    res.json(svc.listAccounts(db, page, limit));
  });

  app.get("/accounts/:id", (req, res) => {
    res.json(svc.getAccount(db, parseId(req.params.id)));
  });

  app.get("/accounts/:id/transactions", (req, res) => {
    const id = parseId(req.params.id);
    const { page, limit } = parsePagination(req.query);
    const type = parseTypeFilter(req.query);
    res.json(svc.listTransactions(db, id, page, limit, type));
  });

  // ---------- transactions ----------
  app.post("/transactions", (req, res) => {
    const b = parseBody(transactionCreateSchema, req.body);
    const { tx, created } = svc.createTransaction(db, {
      accountId: b.account_id,
      type: b.type,
      minor: b.amount,
      referenceId: b.reference_id,
      description: b.description ?? null,
    });
    if (!created) res.set("Idempotent-Replay", "true");
    res.status(created ? 201 : 200).json(tx);
  });

  // ---------- transfers ----------
  app.post("/transfers", (req, res) => {
    const b = parseBody(transferCreateSchema, req.body);
    const result = svc.transfer(db, {
      fromId: b.from_account_id,
      toId: b.to_account_id,
      minor: b.amount,
      referenceId: b.reference_id,
      description: b.description ?? null,
    });
    res.status(201).json(result);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
