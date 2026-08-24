/**
 * The error envelope from PRD §3. Every failure leaving the API takes this
 * shape, so clients can switch on a stable `code` instead of parsing prose.
 *
 *   { "error": { "code": "ORDER_INVALID_TRANSITION", "message": "…", "details": {} } }
 */

/** Registry of every error code the API can emit, with its HTTP status. */
export const ERROR_CODES = {
  // 400 — malformed input
  VALIDATION_FAILED: 400,
  INVALID_CURSOR: 400,

  // 401 — unauthenticated
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  INVALID_REFRESH_TOKEN: 401,

  // 403 — authenticated but not allowed, including out-of-org access
  FORBIDDEN: 403,
  ORDER_FORBIDDEN: 403,
  ACCOUNT_DISABLED: 403,

  // 404
  NOT_FOUND: 404,

  // 409 — state conflict
  ORDER_INVALID_TRANSITION: 409,
  ORDER_ALREADY_TERMINAL: 409,
  ORG_ADMIN_EXISTS: 409,
  EMAIL_ALREADY_REGISTERED: 409,
  INVITE_CODE_REDEEMED: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  IDEMPOTENCY_REQUEST_IN_FLIGHT: 409,
  INVOICE_ALREADY_ISSUED: 409,

  // 422 — well-formed but violates a business rule
  ORDER_NOT_ASSIGNED: 422,
  ORDER_NOT_EDITABLE: 422,
  // Its own code rather than a generic invalid-transition: the fix is for an
  // employee to declare the order ready, not for the caller to change request.
  ORDER_NOT_READY: 422,
  FAILURE_REASON_REQUIRED: 422,
  PAYMENT_DETAILS_REQUIRED: 422,
  PAYMENT_ALREADY_COLLECTED: 422,
  COOLER_BAG_NOT_REQUIRED: 422,
  CLIENT_HAS_ORDERS: 422,
  CLIENT_INACTIVE: 422,
  INVITE_CODE_INVALID: 422,
  INVITE_CODE_EXPIRED: 422,
  DRIVER_RATE_NOT_SET: 422,
  RETENTION_NOT_CONFIGURED: 422,

  // 429
  RATE_LIMITED: 429,
  LOGIN_THROTTLED: 429,

  // 5xx
  INTERNAL_ERROR: 500,
  DEPENDENCY_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = ERROR_CODES[code];
    this.details = details;
  }

  toEnvelope(): {
    error: { code: ErrorCode; message: string; details: Record<string, unknown> };
  } {
    return {
      error: { code: this.code, message: this.message, details: this.details },
    };
  }
}

/** Shorthand constructors for the cases that come up everywhere. */
export const errors = {
  notFound(resource: string, id?: string): AppError {
    // Deliberately identical whether the row is missing or belongs to another
    // organization — a distinguishable 403 would leak that the ID exists.
    return new AppError("NOT_FOUND", `${resource} not found`, id ? { id } : {});
  },

  forbidden(message = "You do not have access to this resource"): AppError {
    return new AppError("FORBIDDEN", message);
  },

  unauthenticated(message = "Authentication required"): AppError {
    return new AppError("UNAUTHENTICATED", message);
  },

  validation(message: string, details: Record<string, unknown> = {}): AppError {
    return new AppError("VALIDATION_FAILED", message, details);
  },
};

/**
 * Postgres constraint violations that carry a specific business meaning.
 * Mapping them here means a race that slips past an application-level check
 * still produces the documented API error rather than a 500 with raw
 * Postgres text (PRD §4.1 calls this out for the one-admin-per-org index).
 */
const CONSTRAINT_ERRORS: Record<string, () => AppError> = {
  idx_one_admin_per_organization: () =>
    new AppError(
      "ORG_ADMIN_EXISTS",
      "This organization already has an admin account",
    ),
  users_email_key: () =>
    new AppError("EMAIL_ALREADY_REGISTERED", "That email is already registered"),
  chk_payment_collected_details: () =>
    new AppError(
      "PAYMENT_DETAILS_REQUIRED",
      "Payment method and amount are required when recording a collection",
    ),
  chk_terminal_status_timestamp: () =>
    new AppError(
      "INTERNAL_ERROR",
      "A status transition was attempted without its timestamp",
    ),
  chk_status_stage_timestamp: () =>
    new AppError(
      "INTERNAL_ERROR",
      "A status transition was attempted without its timestamp",
    ),
  chk_failure_reason_present: () =>
    new AppError(
      "FAILURE_REASON_REQUIRED",
      "A failed delivery must record why it failed",
    ),
  uq_order_packages_position: () =>
    new AppError(
      "INTERNAL_ERROR",
      "Duplicate package position for this order",
    ),
  idx_orders_driver_date_sequence: () =>
    new AppError(
      "INTERNAL_ERROR",
      "Duplicate route position for this driver and date",
    ),
  idx_invoice_line_items_order: () =>
    new AppError(
      "INVOICE_ALREADY_ISSUED",
      "One or more of these deliveries has already been invoiced",
    ),
};

interface PostgresError {
  code?: string;
  constraint?: string;
  detail?: string;
}

/**
 * Translate a driver-level Postgres error into an AppError, or return null if
 * it is not one we recognise (in which case it is a genuine 500).
 */
export function mapDatabaseError(error: unknown): AppError | null {
  const pgError = error as PostgresError;
  if (!pgError?.code) return null;

  if (pgError.constraint) {
    const mapped = CONSTRAINT_ERRORS[pgError.constraint];
    if (mapped) return mapped();
  }

  // 23503 foreign_key_violation on orders.client_id — the client is referenced
  // by delivery history and cannot be hard-deleted (PRD §5.1).
  if (pgError.code === "23503" && pgError.constraint?.includes("client")) {
    return new AppError(
      "CLIENT_HAS_ORDERS",
      "This client has delivery history and cannot be deleted. Deactivate them instead.",
    );
  }

  return null;
}
