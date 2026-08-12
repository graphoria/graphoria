import { z } from "zod";

export const Public_CommentsSchema = z.object({
  author: z.string(),
  body: z.string(),
  created_at: z.string(),
  id: z.number(),
  org_id: z.number(),
  task_id: z.number(),
});

export type Public_Comments = z.infer<typeof Public_CommentsSchema>;
