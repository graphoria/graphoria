import { operation } from "@graphoria/server/config";
import { z } from "zod";
import { insertTaskSchema } from "../repository/tasks";
import type { TasklyRepo } from "../repository";

// Shared schema — GraphQL input and REST body use the same Zod object.
// Extends the pure DB insert schema with the operation-specific "comment" field.
export const createTaskInputSchema = insertTaskSchema.extend({
  comment: z.string().optional(),
});

export const createTaskOutputSchema = z.object({
  taskId: z.number(),
  commented: z.boolean(),
});

export const tasks = {
  createTaskWithComment: operation.typed<{ main: TasklyRepo }>()({
    description: "Create a task (and optional first comment), then publish taskAssigned",
    input: createTaskInputSchema,
    output: createTaskOutputSchema,
    handler: async ({ repository, queues }, input) => {
      const [task] = await repository.main.insertTask({
        org_id: input.org_id,
        project_id: input.project_id,
        title: input.title,
        assignee: input.assignee,
        created_by: input.created_by,
      });

      if (task) {
        if (input.comment) {
          await repository.main.insertComment({
            org_id: input.org_id,
            task_id: task.id,
            author: input.created_by,
            body: input.comment,
          });
        }
        // Publisher resolver name = `${queueName}_${publisherKey}`.
        queues.events_taskAssigned({
          taskId: task.id,
          assignee: input.assignee,
          orgId: input.org_id,
        });
      }

      return { taskId: task!.id, commented: Boolean(input.comment) };
    },
    rest: {
      path: "/tasks",
      method: "POST",
      body: createTaskInputSchema,
    },
  }),
};
