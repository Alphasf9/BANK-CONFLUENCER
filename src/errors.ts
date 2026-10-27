/**
 * One consistent error format for every failure:
 * { "error": { "code": "ACCOUNT_NOT_FOUND", "message": "...", "details": [...] } }
 */
import type { ErrorRequestHandler, RequestHandler } from "express";

export type ErrorDetail = Record<string, unknown>;

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: ErrorDetail[] = []
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errorBody = (code: string, message: string, details: ErrorDetail[] = []) => ({
  error: { code, message, details },
});

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(errorBody("NOT_FOUND", `Route ${req.method} ${req.path} not found`));
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json(errorBody(err.code, err.message, err.details));
    return;
  }
  // body-parser: malformed JSON / oversized payload
  if (err?.type === "entity.parse.failed") {
    res
      .status(400)
      .json(errorBody("INVALID_REQUEST_BODY", "Request body is not valid JSON"));
    return;
  }
  if (err?.type === "entity.too.large") {
    res.status(413).json(errorBody("PAYLOAD_TOO_LARGE", "Request body is too large"));
    return;
  }
  if (process.env.NODE_ENV !== "test") console.error("Unhandled error:", err);
  res.status(500).json(errorBody("INTERNAL_ERROR", "An unexpected error occurred"));
};
