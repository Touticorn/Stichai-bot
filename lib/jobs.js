"use strict";

/**
 * In-memory job queue with concurrency control, WebSocket progress,
 * timeout enforcement and cancellation.
 *
 * Shared state is exported so routes can read activeJobs / jobQueue.
 */

const MAX_QUEUE_CONCURRENCY = parseInt(process.env.MAX_QUEUE_CONCURRENCY) || 2;
const JOB_TIMEOUT_MS        = parseInt(process.env.JOB_TIMEOUT_MS)        || 120000;

/** jobId → { status, progress, message, cancelled, socketId, result, error } */
const activeJobs = new Map();
const jobQueue   = [];
let   runningJobs = 0;
let   _io = null;   // set once by setIo()

/** Called once from bot.js after socket.io is initialised */
function setIo(io) { _io = io; }

function updateJobProgress(jobId, progress, message) {
  const job = activeJobs.get(jobId);
  if (!job) return;
  job.progress = progress;
  if (message) job.message = message;
  if (_io) _io.to(`job:${jobId}`).emit("progress", { jobId, progress, message });
}

/**
 * Enqueue a job function and return a Promise that resolves with its result.
 * fn signature:  async fn(progressCallback) → result
 * progressCallback signature:  (pct:number, message:string) => void
 */
function enqueueJob(jobId, fn, socketId) {
  // Deduplicate — return existing promise if already running/queued
  if (activeJobs.has(jobId)) {
    const existing = activeJobs.get(jobId);
    if (existing.status === "processing" || existing.status === "queued") {
      if (socketId) existing.socketId = socketId;
      return existing._promise;
    }
  }

  const promise = new Promise((resolve, reject) => {
    const job = { jobId, fn, resolve, reject, socketId, cancelled: false };
    jobQueue.push(job);
    processQueue();
  });

  activeJobs.set(jobId, {
    status: "queued", progress: 0, message: "Queued",
    cancelled: false, socketId, _promise: promise
  });

  return promise;
}

async function processQueue() {
  if (runningJobs >= MAX_QUEUE_CONCURRENCY) return;
  const job = jobQueue.shift();
  if (!job) return;

  runningJobs++;
  const record = activeJobs.get(job.jobId) || {};
  record.status   = "processing";
  record.progress = 0;
  record.message  = "Starting…";
  activeJobs.set(job.jobId, record);
  updateJobProgress(job.jobId, 0, "Starting…");

  const timeoutId = setTimeout(() => {
    const active = activeJobs.get(job.jobId);
    if (active && active.status === "processing") {
      active.cancelled = true;
      active.status    = "failed";
      active.error     = "Job timeout";
      updateJobProgress(job.jobId, 0, "Timed out");
      job.reject(new Error("Job timeout"));
    }
  }, JOB_TIMEOUT_MS);

  try {
    const progressCb = (pct, msg) => updateJobProgress(job.jobId, pct, msg);
    const result = await job.fn(progressCb);
    clearTimeout(timeoutId);
    activeJobs.set(job.jobId, {
      status: "done", result, progress: 100, message: "Complete"
    });
    job.resolve(result);
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err.message || "Job failed";
    activeJobs.set(job.jobId, {
      status: "failed", error: msg, progress: 0, message: msg
    });
    job.reject(err);
  } finally {
    runningJobs--;
    processQueue();
  }
}

function cancelJob(jobId) {
  const job = activeJobs.get(jobId);
  if (job && job.status === "processing") {
    job.cancelled = true;
    job.status    = "cancelled";
    updateJobProgress(jobId, 0, "Cancelled by user");
    return true;
  }
  return false;
}

module.exports = {
  activeJobs,
  jobQueue,
  get runningJobs() { return runningJobs; },
  setIo,
  enqueueJob,
  cancelJob,
  updateJobProgress,
  JOB_TIMEOUT_MS,
  MAX_QUEUE_CONCURRENCY,
};
