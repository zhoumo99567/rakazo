import { ComputerResourceUpdateSchema } from "@rakazo/contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
  containerCreateOptions,
  dockerResourceLimits,
  readDockerResourceLimits,
} from "./computer-spec.js";

afterEach(() => vi.unstubAllEnvs());
const input = {
  name: "computer",
  image: "test-image",
  botId: "team-space-1",
  spaceId: "space-1",
  homePath: "/tmp/test-home",
};
it("inherits the supervisor defaults until an individual override is saved", () => {
  vi.stubEnv("RAKAZO_COMPUTER_MEMORY", "3g");
  vi.stubEnv("RAKAZO_COMPUTER_CPUS", "1.5");
  expect(readDockerResourceLimits(containerCreateOptions(input).HostConfig)).toEqual({
    cpus: 1.5,
    memoryMiB: 3072,
  });
  const override = { cpus: 4, memoryMiB: 8192 };
  expect(
    readDockerResourceLimits(
      containerCreateOptions({ ...input, resourceLimits: override }).HostConfig,
    ),
  ).toEqual(override);
});
it("updates CPU and memory without changing the PID ceiling or allowing extra swap", () => {
  expect(dockerResourceLimits({ cpus: 0.5, memoryMiB: 1024 })).toEqual({
    NanoCpus: 500000000,
    Memory: 1073741824,
    MemorySwap: 1073741824,
  });
});
it.each([
  { cpus: 0, memoryMiB: 1024 },
  { cpus: 2, memoryMiB: 0 },
  { cpus: 2, memoryMiB: 5 },
  { cpus: -1, memoryMiB: 1024 },
  { cpus: Infinity, memoryMiB: 1024 },
])("rejects invalid updates: %o", (limits) => {
  expect(ComputerResourceUpdateSchema.safeParse(limits).success).toBe(false);
});
