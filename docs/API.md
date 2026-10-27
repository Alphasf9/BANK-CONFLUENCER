# API Documentation

Base URL: `http://localhost:3000` · JSON in / JSON out.

Amounts are decimal numbers (or numeric strings) with at most 2 decimal places. Timestamps are UTC ISO-8601.

## Error format (all errors)

```json
{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "…", "details": [ {} ] } }
```

| HTTP | code | When |
|---|---|---|
| 400 | `INVALID_REQUEST_BODY` | Malformed JSON, or body is not a JSON object |
| 400 | `INVALID_PAGINATION` | `page < 1`, `limit` not in 1..100, or non-integer |
| 404 | `ACCOUNT_NOT_FOUND` | Account id does not exist |
| 404 | `NOT_FOUND` | Unknown route |
| 409 | `DUPLICATE_TRANSACTION` | `reference_id` reused for the account with different details (or any reuse on a transfer) |
| 413 | `PAYLOAD_TOO_LARGE` | Body larger than 100 KB |
| 422 | `VALIDATION_ERROR` | Missing name, invalid type, amount ≤ 0 or > 2 decimals, missing reference_id, bad id format, unknown fields… (`details` lists field + message) |
| 422 | `INSUFFICIENT_BALANCE` | Debit/transfer exceeds balance (`details` has available / requested) |
| 422 | `INVALID_TRANSFER` | Source and destination are the same account |
| 500 | `INTERNAL_ERROR` | Unexpected failure (everything is rolled back) |

---

## Accounts

### `POST /accounts` → 201
```json
{ "name": "Alice" }
```
Response: `{ "id": 1, "name": "Alice", "balance": 0, "created_at": "…" }`
Name is trimmed, required, max 100 chars. Unknown fields are rejected.

### `GET /accounts?page=1&limit=20` → 200
`{ "data": [Account…], "pagination": { "page", "limit", "total", "total_pages" } }`

### `GET /accounts/:id` → 200 / 404 / 422 (bad id)

---

## Transactions

### `POST /transactions` → 201 (200 on idempotent replay)
```json
{
  "account_id": 1,
  "type": "credit",
  "amount": 100.50,
  "reference_id": "order-123",
  "description": "optional"
}
```
- `type`: `"credit"` or `"debit"`. `amount`: > 0, max 2 decimals. `reference_id`: required, unique per account.

Response:
```json
{ "id": 1, "account_id": 1, "type": "credit", "amount": 100.5, "reference_id": "order-123",
  "description": null, "balance_after": 100.5, "transfer_id": null, "created_at": "…" }
```
- Creating the transaction and updating the balance is one atomic operation.
- Same `account_id` + `reference_id` + `type` + `amount` again → returns the original (`200`, header `Idempotent-Replay: true`), balance unchanged.
- Same `reference_id` with a different type/amount → `409 DUPLICATE_TRANSACTION`.
- Errors: 404 account missing · 422 validation · 422 insufficient balance.

### `GET /accounts/:id/transactions?page=1&limit=20&type=credit` → 200
Newest first. `type` is optional (`credit` | `debit`). Same pagination envelope as accounts.

---

## Transfers (bonus)

### `POST /transfers` → 201
```json
{ "from_account_id": 1, "to_account_id": 2, "amount": 30,
  "reference_id": "tr-1", "description": "optional" }
```
Response:
```json
{
  "transfer_id": "9f2c…", "reference_id": "tr-1", "amount": 30,
  "from_account": { "id": 1, "name": "A", "balance": 70, "created_at": "…" },
  "to_account":   { "id": 2, "name": "B", "balance": 80, "created_at": "…" },
  "debit_transaction":  { "type": "debit",  "account_id": 1, "…": "…" },
  "credit_transaction": { "type": "credit", "account_id": 2, "…": "…" }
}
```
- Both accounts must exist (404), accounts must differ (422), source needs sufficient balance (422).
- Debit + credit are one DB transaction; any failure rolls back both. A partial transfer is impossible.
- Both ledger rows share `transfer_id`. `reference_id` must be unused on both accounts (else 409).

### `GET /health` → `{ "status": "ok" }`
