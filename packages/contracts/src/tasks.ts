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
export const TaskExecutionSchema = z.object({
  heartbeat: z.enum(["current", "expired", "inactive"]),
  leaseExpiresAt: IsoDate.nullable(),
  operations: z.array(
    z.object({
      id: Id,
      state: z.enum(["running", "completed", "timed_out", "cancelled", "unknown"]),
      startedAt: IsoDate.nullable(),
      deadlineAt: IsoDate.nullable(),
      observedAt: IsoDate.nullable(),
      code: z.number().int().nullable(),
    }),
  ),
});
export type TaskExecution = z.infer<typeof TaskExecutionSchema>;
export const TaskSummarySchema = z.object({
  id: Id,
  botId: Id,
  parentTaskId: Id.nullable(),
  status: TaskStatusSchema,
  prompt: z.string(),
  completedAt: IsoDate.nullable(),
  createdAt: IsoDate.optional(),
  botName: z.string().optional(),
  source: z
    .object({
      kind: z.enum(["user", "bot", "routine", "system"]),
      botName: z.string().nullable().optional(),
    })
    .optional(),
  childCount: z.number().int().nonnegative().optional(),
  latestReport: z
    .object({ text: z.string(), reportedAt: IsoDate, kind: z.string() })
    .nullable()
    .optional(),
  pendingMessageCount: z.number().int().nonnegative().optional(),
  reportOverdue: z.boolean().optional(),
  execution: TaskExecutionSchema.optional(),
  lastReportedAt: IsoDate.nullable().optional(),
  lastProgressAt: IsoDate.nullable().optional(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
