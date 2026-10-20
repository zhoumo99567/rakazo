import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

export const BotManagementRoleSchema = z.enum(["member", "chief"]);
export type BotManagementRole = z.infer<typeof BotManagementRoleSchema>;
export const TASK_PROTOCOL = "coordination_v1" as const;
export const TaskStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_children",
  "waiting_input",
  "completed",
  "failed",
  "cancelled",
]);
export const TaskSummarySchema = z.object({
  id: Id,
  botId: Id,
  parentTaskId: Id.nullable(),
  status: TaskStatusSchema,
  prompt: z.string(),
  completedAt: IsoDate.nullable(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
