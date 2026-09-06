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

    ROUTE_OPTIMIZER: z.enum(["fake", "mapbox", "googlemaps"]).default("fake"),
    /**
     * Geocoding and address autocomplete. "fake" returns a fixed set of
     * Montreal addresses, which is enough to exercise the whole pipeline
     * without a key — and renders as a working dropdown in dev.
     */
    GEOCODER: z.enum(["fake", "googlemaps"]).default("fake"),
    /**
     * Traffic-aware ETAs for the driver's remaining run (Routes API).
     *
     * Separate from ROUTE_OPTIMIZER because it is a separate Google product
     * on a separate credential: this one needs only GOOGLE_MAPS_API_KEY, the
     * same plain key as Places. "fake" derives legs from straight-line
     * distance — deterministic, roughly right, and honest about knowing
     * nothing of traffic.
     */
    TRAVEL_TIME: z.enum(["fake", "googlemaps"]).default("fake"),
    NOTIFICATION_SENDER: z.enum(["fake", "twilio"]).default("fake"),

    MAPBOX_ACCESS_TOKEN: z.string().optional(),

    /**
     * Places (New) uses a plain API key; Route Optimization is a Cloud API and
     * takes a service account. Two different credentials for two different
     * Google products — a common enough surprise that they are named apart
     * rather than collapsed into one GOOGLE_API_KEY that only half works.
     */
    GOOGLE_MAPS_API_KEY: z.string().optional(),
    GOOGLE_CLOUD_PROJECT_ID: z.string().optional(),
    /** The service account JSON, inline. Deployed from Secrets Manager. */
    GOOGLE_APPLICATION_CREDENTIALS_JSON: z.string().optional(),

    /**
     * ISO 3166-1 alpha-2, comma separated. Restricts suggestions to where the
     * pharmacy actually delivers — an address in another country can only
     * ever be picked by mistake. Empty means no restriction.
     */
    GEOCODE_COUNTRY: z
      .string()
      .default("ca")
      .transform((v) =>
        v
          .split(",")
          .map((c) => c.trim().toUpperCase())
          .filter(Boolean),
      ),
    GEOCODE_LANGUAGE: z.string().default("fr-CA"),
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
    /*
      Only the project id is required. The service-account key is deliberately
      optional: without one the client uses Application Default Credentials —
      an attached service account on GCP, workload identity elsewhere, or a
      developer's own gcloud login. That is the better arrangement, and often
      the only one available, since newer Google Cloud organizations block
      service-account key creation by default
      (constraints/iam.disableServiceAccountKeyCreation).

      A malformed key is worth catching here rather than at the first optimize:
      JSON.parse runs in the adapter's constructor, and a stray newline from a
      paste would otherwise take down the route instead of the boot.
    */
    if (env.ROUTE_OPTIMIZER === "googlemaps" && !env.GOOGLE_CLOUD_PROJECT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GOOGLE_CLOUD_PROJECT_ID"],
        message: "required when ROUTE_OPTIMIZER=googlemaps",
      });
    }
    if (env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      try {
        JSON.parse(env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["GOOGLE_APPLICATION_CREDENTIALS_JSON"],
          message:
            "must be the service account JSON on a single line (a .env value cannot span lines)",
        });
      }
    }
    if (env.GEOCODER === "googlemaps" && !env.GOOGLE_MAPS_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GOOGLE_MAPS_API_KEY"],
        message: "required when GEOCODER=googlemaps",
      });
    }
    if (env.TRAVEL_TIME === "googlemaps" && !env.GOOGLE_MAPS_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GOOGLE_MAPS_API_KEY"],
        message: "required when TRAVEL_TIME=googlemaps",
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
