import { operation } from "@graphoria/server/config";
import { z } from "zod";

// Shared schema — GraphQL input and REST query params use the same Zod object.
// This is the key insight: one schema validates both transport layers.
export const dashboardInputSchema = z.object({ assignee: z.string() });

export const dashboard = {
  dashboard: operation({
    description: "Open tasks assigned to a user, highest priority first",
    input: dashboardInputSchema,
    query: `
      query Dashboard($assignee: String!) {
        public_tasks(
          where: { assignee: { eq: $assignee }, status: { neq: "done" } }
          orderBy: [{ priority: DESC }]
        ) {
          id
          title
          status
          priority
          due_date
          is_overdue
          age_days
        }
      }
    `,
    cache: { ttl: 15000, max: 500 },
    rest: {
      path: "/dashboard",
      method: "GET",
      queryParams: dashboardInputSchema,
    },
  }),
};
