/**
 * Background jobs: a batch that returns before it finishes.
 *
 * MCP is request/response, so a client waits on every call. An agent driving a
 * slow flow on one tab — a checkout with three page loads, a report that takes
 * a minute to generate — sits idle for the whole of it, when it could be
 * reading another tab or reasoning about the next step. `browser_batch
 * async:true` hands back a job id at once; `browser_wait for:"job"` collects
 * the result later, and reports progress if it is not done yet. A client that
 * issues independent tool calls concurrently gets genuine overlap out of this;
 * one that does not still gets to interleave its own thinking with the work.
 *
 * In-memory on purpose. A job is a promise running inside this worker, and it
 * cannot survive the worker being torn down anyway — so a record in storage
 * would only ever describe a job that no longer exists. The socket heartbeat
 * keeps the worker alive while a job runs; if it is recycled regardless, the
 * job is simply gone and `for:"job"` says so rather than hanging.
 *
 * Pure: no Chrome APIs, so the registry is unit-testable.
 */

const jobs = new Map();
let counter = 0;

/** Finished jobs are kept this long so a late collect still finds them. */
const RETAIN_MS = 10 * 60 * 1000;

/**
 * Register a job and start it.
 *
 * @param {object} meta {session, tool, steps}
 * @param {(progress: (info: object) => void) => Promise<any>} start
 * @returns {{id: string}}
 */
export function startJob(meta, start) {
  const id = `job${++counter}`;
  const job = {
    id,
    session: meta.session ?? null,
    tool: meta.tool,
    steps: meta.steps ?? 0,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    progress: null,
    result: null,
    error: null,
    waiters: new Set(),
  };
  jobs.set(id, job);

  const progress = (info) => {
    job.progress = info;
  };

  Promise.resolve()
    .then(() => start(progress))
    .then(
      (result) => finish(job, { status: 'done', result }),
      (err) => finish(job, { status: 'failed', error: err?.message || String(err) })
    );

  return { id };
}

function finish(job, patch) {
  Object.assign(job, patch, { finishedAt: Date.now() });
  for (const resolve of job.waiters) resolve(job);
  job.waiters.clear();
  setTimeout(() => {
    if (jobs.get(job.id) === job) jobs.delete(job.id);
  }, RETAIN_MS);
}

/** The job, or null. A session may only see its own jobs. */
export function getJob(id, session) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.session && session && job.session !== session) return null;
  return job;
}

/** Every job a session owns, newest first. */
export function listJobs(session) {
  return [...jobs.values()].filter((j) => !session || j.session === session).sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Resolve with the job once it has finished, or after `timeout` with it still
 * running — the caller reads `status` to tell which.
 */
export function waitForJob(job, timeout) {
  if (job.status !== 'running') return Promise.resolve(job);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      job.waiters.delete(done);
      resolve(job);
    }, timeout);
    const done = (j) => {
      clearTimeout(timer);
      resolve(j);
    };
    job.waiters.add(done);
  });
}

/** One line a model can act on. */
export function describeJob(job) {
  const age = Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000);
  if (job.status === 'running') {
    const p = job.progress;
    const at = p ? ` — at step ${p.label ?? p.i}${p.tool ? ` (${p.tool})` : ''}` : '';
    return `${job.id} running ${age}s${at}`;
  }
  return `${job.id} ${job.status} after ${age}s`;
}

/** Test hook: forget everything. */
export function _resetJobs() {
  jobs.clear();
  counter = 0;
}
