import { z } from "zod";

export const Public_TasksSchema = z.object({
  age_days: z.number(),
  assignee: z.string().nullish(),
  created_at: z.string(),
  created_by: z.string(),
  description: z.string().nullish(),
  due_date: z.string().nullish(),
  id: z.number(),
  is_overdue: z.boolean(),
  org_id: z.number(),
  priority: z.number(),
  project_id: z.number(),
  status: z.string(),
  title: z.string(),
  updated_at: z.string(),
});

export type Public_Tasks = z.infer<typeof Public_TasksSchema>;
