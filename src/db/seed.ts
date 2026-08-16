/**
 * Development seed.
 *
 * Creates TWO organizations deliberately: organization isolation (PRD §4.4)
 * is the invariant most worth testing, and it cannot be tested against a
 * single-tenant database. Every fixture here has a counterpart in the other
 * org so a leak shows up as visible data rather than an empty result.
 *
 * Idempotent — safe to re-run.
 */
import { hashPassword } from "../modules/auth/password.js";
import { closeDb, db } from "./knex.js";

const PASSWORD = "DevPassword123!";

interface OrgFixture {
  name: string;
  slug: string;
  locale: "fr" | "en";
  deliveryRate: number;
  clients: { name: string; address: string; phone: string; notes?: string }[];
}

const FIXTURES: OrgFixture[] = [
  {
    name: "Pharmacie Saint-Laurent",
    slug: "stlaurent",
    locale: "fr",
    deliveryRate: 6.5,
    clients: [
      {
        name: "Marie Tremblay",
        address: "1250 Rue Sainte-Catherine O, Montréal, QC H3G 1P5",
        phone: "+15145550142",
        notes: "Code de porte 4412",
      },
      {
        name: "Jean Bouchard",
        address: "4100 Rue Sherbrooke E, Montréal, QC H1X 2B2",
        phone: "+15145550188",
        notes: "Laisser au concierge",
      },
    ],
  },
  {
    name: "Riverside Drugstore",
    slug: "riverside",
    locale: "en",
    deliveryRate: 7.25,
    clients: [
      {
        name: "Susan Clarke",
        address: "88 Queen St W, Toronto, ON M5H 2N2",
        phone: "+14165550119",
      },
    ],
  },
];

async function seedOrganization(
  fixture: OrgFixture,
  passwordHash: string,
): Promise<void> {
  await db.transaction(async (trx) => {
    let org = await trx("organizations").where({ name: fixture.name }).first();

    if (!org) {
      [org] = await trx("organizations")
        .insert({
          name: fixture.name,
          address: `1 Main St, ${fixture.slug}`,
          phone: "+15145550100",
          email: `contact@${fixture.slug}.example.ca`,
          locale: fixture.locale,
          delivery_rate: fixture.deliveryRate,
        })
        .returning("*");
    }

    const adminEmail = `admin@${fixture.slug}.example.ca`;
    const existingAdmin = await trx("users").where({ email: adminEmail }).first();
    if (!existingAdmin) {
      await trx("users").insert({
        organization_id: org.id,
        role: "admin",
        email: adminEmail,
        password_hash: passwordHash,
        first_name: "Admin",
        last_name: fixture.name.split(" ")[0],
        phone: "+15145550101",
      });
    }

    const driverEmail = `driver@${fixture.slug}.example.ca`;
    const existingDriver = await trx("users")
      .where({ email: driverEmail })
      .first();
    if (!existingDriver) {
      await trx("users").insert({
        organization_id: org.id,
        role: "driver",
        email: driverEmail,
        password_hash: passwordHash,
        first_name: "Driver",
        last_name: fixture.name.split(" ")[0],
        phone: "+15145550102",
      });
    }

    for (const client of fixture.clients) {
      const exists = await trx("clients")
        .where({ organization_id: org.id, name: client.name })
        .first();
      if (!exists) {
        await trx("clients").insert({
          organization_id: org.id,
          name: client.name,
          address: client.address,
          phone_number: client.phone,
          notes: client.notes ?? null,
        });
      }
    }

    console.log(`  seeded  ${fixture.name}  (${adminEmail} / ${driverEmail})`);
  });
}

try {
  console.log("Seeding development data...");
  // Hashed once and reused: Argon2id is intentionally slow, and every seeded
  // account shares the same development password anyway.
  const passwordHash = await hashPassword(PASSWORD);

  for (const fixture of FIXTURES) {
    await seedOrganization(fixture, passwordHash);
  }

  console.log(`\nAll seeded accounts use the password: ${PASSWORD}`);
} catch (error) {
  console.error("Seed failed:", error);
  process.exitCode = 1;
} finally {
  await closeDb();
}
