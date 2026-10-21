import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: true,
};
function setup(
  options: {
    exists?: boolean;
    busy?: boolean;
    provisioned?: boolean;
    kind?: string;
    stored?: object;
  } = {},
) {
  const computer = {
    id: "computer-1",
    homeKey: "team-space-1",
    kind: options.kind ?? "docker",
    scope: "team",
    providerRef: options.provisioned === false ? null : "container-1",
    resourceLimits: options.stored ?? null,
  };
  const findFirst = vi.fn(async () =>
    options.exists === false ? null : { id: "bot-1", computer },
  );
  const update = vi.fn(async () => computer);
  const updateMany = vi.fn(async () => ({ count: options.busy ? 0 : 1 }));
  const resourceLimits = vi.fn(async () => ({ cpus: 2, memoryMiB: 2048 }));
  const setResourceLimits = vi.fn(async (_ref, limits) => limits);
  const deps = {
    prisma: {
      bot: { findFirst },
      computer: { update, updateMany },
      $transaction: vi.fn(async (fn) => fn({ computer: { update, updateMany } })),
    },
    sandbox: { resourceLimits, setResourceLimits },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-secret",
      sandboxProvider: "docker",
    },
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function call(path: string, limits?: object) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/computer/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot-1", ...(limits ? { limits } : {}) } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }
  return { call, findFirst, update, updateMany, resourceLimits, setResourceLimits };
}

describe("computer resource limits", () => {
  it("uses supervisor defaults before the first boot", async () => {
    const fixture = setup({ provisioned: false });
    expect((await fixture.call("resources")).status).toBe(200);
    expect(fixture.resourceLimits).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ spaceId: actor.spaceId }),
    );
  });
  it("uses saved limits for an unprovisioned computer", async () => {
    const fixture = setup({ provisioned: false, stored: { cpus: 4, memoryMiB: 8192 } });
    expect(await (await fixture.call("resources")).json()).toEqual({
      json: { cpus: 4, memoryMiB: 8192 },
    });
    expect(fixture.resourceLimits).not.toHaveBeenCalled();
  });
  it("updates the shared container and persists its limits", async () => {
    const fixture = setup();
    const limits = { cpus: 4, memoryMiB: 8192 };
    const response = await fixture.call("setResources", limits);
    expect(response.status, await response.text()).toBe(200);
    expect(fixture.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: actor.userId, spaceId: actor.spaceId }),
      }),
    );
    expect(fixture.setResourceLimits).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "team-space-1" }),
      limits,
      expect.anything(),
    );
    expect(fixture.update).toHaveBeenCalledWith({
      where: { id: "computer-1" },
      data: { resourceLimits: limits },
    });
    expect(fixture.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { maintenanceId: null } }),
    );
  });
  it("does not change limits while another operation owns the computer", async () => {
    const fixture = setup({ busy: true });
    expect((await fixture.call("setResources", { cpus: 4, memoryMiB: 8192 })).status).toBe(409);
    expect(fixture.setResourceLimits).not.toHaveBeenCalled();
  });
  it("does not expose another user's computer", async () => {
    const fixture = setup({ exists: false });
    expect((await fixture.call("resources")).status).not.toBe(200);
    expect(fixture.resourceLimits).not.toHaveBeenCalled();
  });
  it("rejects unsupported providers and invalid resource values", async () => {
    const fixture = setup({ kind: "desktop" });
    expect((await fixture.call("setResources", { cpus: 4, memoryMiB: 8192 })).status).toBe(400);
    expect((await fixture.call("setResources", { cpus: -1, memoryMiB: 1 })).status).toBe(400);
    expect(fixture.setResourceLimits).not.toHaveBeenCalled();
  });
  it("leaves saved limits intact and releases its reservation after a Docker error", async () => {
    const fixture = setup();
    fixture.setResourceLimits.mockRejectedValueOnce(new Error("Docker rejected the limit"));
    expect((await fixture.call("setResources", { cpus: 4, memoryMiB: 8192 })).status).not.toBe(200);
    expect(fixture.update).not.toHaveBeenCalled();
    expect(fixture.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { maintenanceId: null } }),
    );
  });
});
