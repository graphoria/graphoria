import { createGraphQLEngine } from "@graphoria/server";

const { execute } = await createGraphQLEngine();

const data = await execute(
  `
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
  {
    assignee: "evan",
  },
  {
    role: "superadmin",
  },
);

console.log(data);
