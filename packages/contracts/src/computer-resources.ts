import * as z from "zod";

/** Zero means unlimited. Memory is expressed in MiB, never host-dependent units. */
export const ComputerResourceLimitsSchema = z.object({
  cpus: z
    .number()
    .finite()
    .min(0)
    .max(1024)
    .refine((value) => value === 0 || value >= 0.01),
  memoryMiB: z
    .number()
    .int()
    .min(0)
    .max(2147483647)
    .refine((value) => value === 0 || value >= 6),
});
export type ComputerResourceLimits = z.infer<typeof ComputerResourceLimitsSchema>;

export const ComputerResourceUpdateSchema = ComputerResourceLimitsSchema.refine(
  (limits) => limits.cpus > 0 && limits.memoryMiB >= 6,
  { message: "Set a positive CPU limit and at least 6 MiB of memory" },
);
