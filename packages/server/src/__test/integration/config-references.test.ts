import { beforeAll, describe, expect, it } from "bun:test";

import { fieldName } from "./config";
import { integrationEnabled, startServer } from "./harness";
import { seedEngine } from "./seed";

/**
 * Boot-time cross-reference validation, proved against a real introspected
 * schema rather than a hand-built table list — the unit tests cover the rules,
 * this covers that the names they resolve against are the ones a live database
 * actually reports.
 *
 * One engine only, deliberately: the check reads the parsed configuration and
 * the introspection result, and neither the rules nor the messages differ by
 * dialect. Running it three times would prove the same thing three times.
 */

const users = fieldName("pg", "app", "users");

const boot = async (anonymous: Record<string, unknown>) => {
  const started = await startServer({
    engine: "pg",
    skipSeed: true,
    config: {
      auth: { enabled: false, database: "", permissions: { anonymous } },
    } as never,
  });

  await started.stop();
};

describe.skipIf(!integrationEnabled)("integration config cross-references", () => {
  beforeAll(async () => {
    await seedEngine("pg");
  });

  it("boots when every reference resolves", async () => {
    await expect(
      boot({ tables: { [users]: { columns: ["id", "organization_id"] } }, storedProcedures: [] }),
    ).resolves.toBeUndefined();
  });

  it("refuses to boot on a role permission naming a table that does not exist", async () => {
    await expect(
      boot({ tables: { app_userz: { columns: "ALL" } }, storedProcedures: [] }),
    ).rejects.toThrow(
      `auth.permissions.anonymous.tables.app_userz — no table or view named "app_userz" (did you mean "${users}"?)`,
    );
  });

  it("refuses to boot on a role filter naming a column that does not exist", async () => {
    await expect(
      boot({
        tables: { [users]: { columns: "ALL", filter: { organization_di: { eq: "1" } } } },
        storedProcedures: [],
      }),
    ).rejects.toThrow(
      `filter.organization_di — no column on table "${users}" named "organization_di" (did you mean "organization_id"?)`,
    );
  });

  it("reports every unresolved reference in one message", async () => {
    const error = await boot({
      tables: { app_userz: { columns: "ALL" }, app_projectz: { columns: "ALL" } },
      storedProcedures: ["no_such_procedure"],
    }).catch((err: Error) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("3 names that do not exist");
    expect((error as Error).message).toContain("app_userz");
    expect((error as Error).message).toContain("app_projectz");
    expect((error as Error).message).toContain("no_such_procedure");
  });
});
