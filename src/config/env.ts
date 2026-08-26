import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

/**
 * Environment schema. Validated once at boot so a misconfigured deployment
 * fails immediately and loudly, rather than at the first request that happens
 * to need the missing value.
 */
const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    DATABASE_POOL_MIN: z.coerce.number().int().min(0).default(2),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

    REDIS_URL: z.string().min(1, "REDIS_URL is required"),

    JWT_SECRET: z
      .string()
      .min(32, "JWT_SECRET must be at least 32 characters"),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

    INTERNAL_API_TOKEN: z
      .string()
      .min(16, "INTERNAL_API_TOKEN must be at least 16 characters"),

    CORS_ORIGINS: z.string().default(""),

    /**
     * Operational kill-switch for the Socket.IO layer (PRD §7). Off means the
     * driver app falls back to its 30-second poll, which is the behaviour the
     * app is written to degrade to anyway.
     *
     * Spelled out rather than z.coerce.boolean(), which parses the string
     * "false" as true and would make the switch impossible to turn off.
     */
    REALTIME_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),

    ROUTE_OPTIMIZER: z.enum(["fake", "mapbox"]).default("fake"),
    NOTIFICATION_SENDER: z.enum(["fake", "twilio"]).default("fake"),

    MAPBOX_ACCESS_TOKEN: z.string().optional(),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),

    DRIVER_LOCATION_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .positive()
      .default(90),

    /**
     * Deliberately optional. PRD §12 Q4 leaves the order retention window to
     * the pharmacy's legal counsel — the anonymization job stays disabled
     * until a real value is set, because purging PII on a guess is worse than
     * not purging it yet.
     */
    ORDER_RETENTION_DAYS: z
      .string()
      .trim()
      .transform((v) => (v === "" ? undefined : Number(v)))
      .pipe(z.number().int().positive().optional())
      .optional(),
  })
  // A "real provider" selection without its credentials is a deployment
  // mistake that would otherwise only surface when the first driver taps
  // optimize, or the first patient fails to get a notification.
  .superRefine((env, ctx) => {
    if (env.ROUTE_OPTIMIZER === "mapbox" && !env.MAPBOX_ACCESS_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MAPBOX_ACCESS_TOKEN"],
        message: "required when ROUTE_OPTIMIZER=mapbox",
      });
    }
    if (env.NOTIFICATION_SENDER === "twilio") {
      for (const key of [
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_MESSAGING_SERVICE_SID",
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: "required when NOTIFICATION_SENDER=twilio",
          });
        }
      }
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${details}`);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === "production",
  isTest: raw.NODE_ENV === "test",
  corsOrigins: raw.CORS_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean),
} as const;

export type Env = typeof env;
