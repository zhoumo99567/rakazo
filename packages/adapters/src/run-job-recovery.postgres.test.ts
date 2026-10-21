import { randomUUID } from "node:crypto";
import { makeWorkerUtils } from "graphile-worker";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recoverExpiredRunJob } from "./run-job-recovery.js";

const postgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
postgres("expired run queue locks", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  beforeAll(async () => {
    const utils = await makeWorkerUtils({ pgPool: pool });
    try {
      await utils.migrate();
    } finally {
      await utils.release();
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  it.each([
    {
      name: "expired running run",
      status: "running",
      expiry: -60,
      lock: -120,
      task: "run.continue",
      queue: null,
      recovered: true,
    },
    {
      name: "expired leased run",
      status: "leased",
      expiry: -60,
      lock: -120,
      task: "run.continue",
      queue: null,
      recovered: true,
    },
    {
      name: "live lease on another worker",
      status: "running",
      expiry: 60,
      lock: -120,
      task: "run.continue",
      queue: null,
      recovered: false,
    },
    {
      name: "newly acquired queue lock",
      status: "running",
      expiry: -60,
      lock: -10,
      task: "run.continue",
      queue: null,
      recovered: false,
    },
    {
      name: "completed run",
      status: "completed",
      expiry: -60,
      lock: -120,
      task: "run.continue",
      queue: null,
      recovered: false,
    },
    {
      name: "waiting for input",
      status: "waiting_input",
      expiry: -60,
      lock: -120,
      task: "run.continue",
      queue: null,
      recovered: false,
    },
    {
      name: "different task type",
      status: "running",
      expiry: -60,
      lock: -120,
      task: "routine.wakeup",
      queue: null,
      recovered: false,
    },
    {
      name: "named queue",
      status: "running",
      expiry: -60,
      lock: -120,
      task: "run.continue",
      queue: "other-queue",
      recovered: false,
    },
  ])("$name", async ({ status, expiry, lock, task, queue, recovered }) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      // A transaction-local run table avoids fixtures or changes to real application data.
      await client.query(
        'create temporary table runs (id text primary key, status text, "leaseExpiresAt" timestamptz) on commit drop',
      );
      const id = randomUUID();
      const key = `run:${id}`;
      await client.query("insert into runs values ($1, $2, now() + $3 * interval '1 second')", [
        id,
        status,
        expiry,
      ]);
      await client.query(
        "select graphile_worker.add_job($1, $2::json, queue_name := $3, job_key := $4)",
        [task, JSON.stringify({ runId: id }), queue, key],
      );
      await client.query(
        "update graphile_worker._private_jobs set locked_by = 'old-worker', locked_at = now() + $2 * interval '1 second' where key = $1",
        [key, lock],
      );
      await client.query(
        "select graphile_worker.add_job('run.continue', $1::json, job_key := $2)",
        [JSON.stringify({ runId: `${id}-other` }), `${key}-other`],
      );
      await client.query(
        "update graphile_worker._private_jobs set locked_by = 'old-worker', locked_at = now() where key = $1",
        [`${key}-other`],
      );
      // Matching a key alone must not unlock a job for a different run.
      expect((await recoverExpiredRunJob(client, `${id}-other`, key)).rowCount).toBe(0);
      const result = await recoverExpiredRunJob(client, id, key);
      expect(result.rowCount).toBe(recovered ? 1 : 0);
      const row = await client.query(
        "select locked_by, attempts from graphile_worker._private_jobs where key = $1",
        [key],
      );
      expect(row.rows[0]).toMatchObject({
        locked_by: recovered ? null : "old-worker",
        attempts: 0,
      });
      expect((await recoverExpiredRunJob(client, id, key)).rowCount).toBe(0);
      const sibling = await client.query(
        "select locked_by from graphile_worker._private_jobs where key = $1",
        [`${key}-other`],
      );
      expect(sibling.rows[0].locked_by).toBe("old-worker");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
