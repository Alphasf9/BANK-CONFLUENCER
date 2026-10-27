# Assumptions

The brief I worked from began at "Atomicity / 7. Validations", so the endpoint list and data model (sections 1–6)
were inferred from the validation and error-handling requirements.

1. **Endpoints:** `POST/GET /accounts`, `GET /accounts/:id`, `POST /transactions` (account id in the body, per
   "Account ID must exist when creating a transaction"), `GET /accounts/:id/transactions` (paginated, optional
   `type` filter), `POST /transfers`.
2. **Accounts start at balance 0.** Money enters via `credit` transactions, so every balance is explained by the ledger.
3. **Currency:** single implicit currency; amounts have at most 2 decimal places and are stored as integer minor units
   (max 12 integer digits).
4. **reference_id** is client-supplied and unique *per account*. Replaying an identical request is treated as an
   idempotent retry (returns the original, never double-applies); a conflicting reuse is a 409.
5. **Transfers** use the same `reference_id` on both ledger legs (allowed because uniqueness is per account) and are
   linked by a generated `transfer_id`. A duplicate transfer `reference_id` is rejected with 409. Transfers to the same
   account are rejected.
6. **Status codes:** validation → 422, malformed JSON / bad pagination → 400, missing account → 404,
   duplicate → 409, insufficient balance → 422.
7. **Pagination:** `page` ≥ 1 (default 1), `limit` 1–100 (default 20); transactions are newest first.
8. **No authentication / authorisation** — out of scope for this exercise; it would sit in front of these routes.
9. **Concurrency model:** SQLite serialises writers (`BEGIN IMMEDIATE`). For a multi-node deployment I would move to
   PostgreSQL and use `SELECT … FOR UPDATE` (locking accounts in id order to avoid deadlocks); the service layer stays the same.
10. **Ledger is append-only:** accounts and transactions are never edited or deleted.
