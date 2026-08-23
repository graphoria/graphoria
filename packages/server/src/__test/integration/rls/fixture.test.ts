import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { StartedRls } from "./fixture";

import { ENGINES, fieldName } from "../config";
import { integrationEnabled } from "../harness";
import { RLS_USERS, startRlsServer } from "./fixture";

/**
 * Acceptance for task 3.1: the fixture boots against all three engines and
 * every role in it can obtain a token. The escape and injection suites all rest
 * on this, so it is asserted once here rather than implicitly in each of them.
 */

describe.skipIf(!integrationEnabled)("rls · fixture", () => {
  for (const engine of ENGINES) {
    describe(engine, () => {
      let started: StartedRls;

      beforeAll(async () => {
        started = await startRlsServer(engine);
      });

      afterAll(async () => {
        await started?.stop();
      });

      it("mints a token for every fixture user", async () => {
        for (const key of Object.keys(RLS_USERS) as (keyof typeof RLS_USERS)[]) {
          const token = await started.context.tokenFor(key);
          expect(token.length).toBeGreaterThan(0);
        }
      });

      it("sees both tenants as admin", async () => {
        const tasks = fieldName(engine, "app", "tasks");
        const token = await started.context.tokenFor("admin");

        const response = await started.context.gql<Record<string, { id: number }[]>>(
          `{ ${tasks} { id } }`,
          undefined,
          { token },
        );

        expect(response.errors).toBeUndefined();
        expect(response.data?.[tasks]).toHaveLength(10);
      });
    });
  }
});
