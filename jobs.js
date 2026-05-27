'use strict';

// NOTE: keep in sync with LRUMap in bot.js.
class LRUMap extends Map {
  constructor(limit = 100) {
    super();
    this.limit = limit;
  }
  get(key) {
    if (!super.has(key)) return undefined;
    const val = super.get(key);
    super.delete(key);
    super.set(key, val);
    return val;
  }
  set(key, val) {
    if (super.has(key)) super.delete(key);
    super.set(key, val);
    if (this.size > this.limit) {
      const first = this.keys().next().value;
      super.delete(first);
    }
    return this;
  }
}

const MAX_QUEUE_CONCURRENCY = Number(process.env.MAX_QUEUE_CONCURRENCY || 2);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 120000);
const CACHE_MAX_SIZE = Number(process.env.CACHE_MAX_SIZE || 50);

let io = null;
const jobs = new LRUMap(CACHE_MAX_SIZE);
const jobQueue = [];
let runningJobs = 0;

function setIO(socketServer) {
  io = socketServer;
}

function getQueueStats() {
  return { queueLength: jobQueue.length, running: runningJobs };
}

function updateJobProgress(jobId, progress, message) {
  const j = jobs.get(jobId);
  if (!j) return;
  j.progress = progress;
  if (message !== undefined) j.message = message;
  jobs.set(jobId, j);
  if (io) {
    io.to(`job:${jobId}`).emit('progress', { jobId, progress, message });
  }
}

function enqueueJob(jobId, fn, socketId) {
  jobQueue.push({ jobId, fn, socketId });
  processQueue().catch(() => {});
}

async function processQueue() {
  if (runningJobs >= MAX_QUEUE_CONCURRENCY) return;
  if (!jobQueue.length) return;

  while (runningJobs < MAX_QUEUE_CONCURRENCY && jobQueue.length) {
    const item = jobQueue.shift();
    if (!item) break;

    const { jobId, fn } = item;
    const j = jobs.get(jobId);
    if (!j) continue;
    if (j.status === 'cancelled') continue;

    runningJobs++;
    jobs.set(jobId, { ...j, status: 'running', startedAt: Date.now() });
    updateJobProgress(jobId, j.progress || 1, j.message || 'Processing...');

    (async () => {
      try {
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Job timeout')), JOB_TIMEOUT_MS)
        );
        await Promise.race([Promise.resolve(fn()), timeout]);
      } catch (err) {
        const curr = jobs.get(jobId);
        if (curr && curr.status !== 'cancelled' && curr.status !== 'done') {
          jobs.set(jobId, {
            ...curr,
            status: 'error',
            error: (err && err.message) || 'Job failed',
            finishedAt: Date.now()
          });
          updateJobProgress(jobId, curr.progress || 0, (err && err.message) || 'Job failed');
        }
      } finally {
        runningJobs--;
        processQueue().catch(() => {});
      }
    })();
  }
}

function cancelJob(jobId) {
  const j = jobs.get(jobId);
  if (!j) return false;

  // Remove queued instance if present
  const idx = jobQueue.findIndex((x) => x.jobId === jobId);
  if (idx >= 0) jobQueue.splice(idx, 1);

  jobs.set(jobId, {
    ...j,
    status: 'cancelled',
    cancelled: true,
    finishedAt: Date.now(),
    message: 'Cancelled'
  });
  updateJobProgress(jobId, j.progress || 0, 'Cancelled');
  return true;
}

module.exports = {
  jobs,
  jobQueue,
  enqueueJob,
  processQueue,
  cancelJob,
  updateJobProgress,
  setIO,
  getQueueStats
};
