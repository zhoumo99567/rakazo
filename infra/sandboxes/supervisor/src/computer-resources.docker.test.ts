import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveSupervisorToken } from "@rakazo/core";
import { expect, it } from "vitest";
import { supervisorApp } from "./index.js";

// Uses only a preinstalled BusyBox image and an isolated disposable container.
it.skipIf(process.env.VERIFY_DOCKER_RESOURCES !== "1")(
  "updates a running computer through the authenticated supervisor without restarting",
  async () => {
    const botId = `resource-test-${randomUUID()}`;
    const docker = (...args: string[]) =>
      execFileSync("docker", args, { encoding: "utf8", timeout: 30000 }).trim();
    const id = docker(
      "run",
      "-d",
      "--network",
      "none",
      "--memory",
      "64m",
      "--memory-swap",
      "64m",
      "--cpus",
      "0.5",
      "--label",
      "rakazo.managed=true",
      "--label",
      `rakazo.botId=${botId}`,
      "--label",
      "rakazo.spaceId=test-space",
      "busybox:1",
      "sleep",
      "120",
    );
    try {
      const before = JSON.parse(docker("inspect", id))[0];
      const headers = {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "x-rakazo-bot-id": botId,
        "x-rakazo-space-id": "test-space",
        "content-type": "application/json",
      };
      const denied = await supervisorApp.request(`/computers/${id}/resources`, {
        method: "POST",
        headers: { ...headers, "x-rakazo-space-id": "another-space" },
        body: JSON.stringify({ cpus: 1, memoryMiB: 128 }),
      });
      expect(denied.status).toBe(404);
      for (const limits of [
        { cpus: 1, memoryMiB: 128 },
        { cpus: 0.5, memoryMiB: 64 },
      ]) {
        const response = await supervisorApp.request(`/computers/${id}/resources`, {
          method: "POST",
          headers,
          body: JSON.stringify(limits),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(limits);
        const after = JSON.parse(docker("inspect", id))[0];
        expect(after.State.Running).toBe(true);
        expect(after.State.StartedAt).toBe(before.State.StartedAt);
      }
    } finally {
      docker("rm", "-f", id);
    }
  },
);
