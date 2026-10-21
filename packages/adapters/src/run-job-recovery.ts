import type { PoolClient } from "pg";

/** Run leases/fences are authoritative; Graphile's longer lock must not block recovery. */
export async function recoverExpiredRunJob(
  client: Pick<PoolClient, "query">,
  runId: string,
  jobKey: string,
) {
  return client.query(
    `with expired as materialized (
       select id, "leaseExpiresAt" from runs
       where id = $1 and status in ('leased', 'running')
         and "leaseExpiresAt" < now()
       for update skip locked
     )
     update graphile_worker._private_jobs as jobs
     set locked_at = null, locked_by = null
     from expired, graphile_worker._private_tasks as tasks
     where jobs.key = $2 and jobs.payload->>'runId' = expired.id
       and tasks.id = jobs.task_id and tasks.identifier = 'run.continue'
       and jobs.job_queue_id is null
       and jobs.locked_by is not null
       and jobs.locked_at < expired."leaseExpiresAt"
     returning jobs.id`,
    [runId, jobKey],
  );
}
