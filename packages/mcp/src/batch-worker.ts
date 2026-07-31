import { parentPort } from 'node:worker_threads';
import { convertForBatch, type BatchFileTask } from './tools.js';

/**
 * Pool worker entry point.
 *
 * Deliberately thin: it owns no policy, just receives one file's task, runs the
 * same conversion the single-file tool uses, and posts the result back. All the
 * decisions — which files, which settings, whether to skip — stay in the parent,
 * so the worker cannot drift from the rest of the server's behaviour.
 *
 * Errors never escape as exceptions. `convertForBatch` turns them into a `failed`
 * result, which keeps a single unreadable file from killing the thread and losing
 * whatever else was queued on it.
 */

if (!parentPort) {
  throw new Error('batch-worker must be started as a worker thread.');
}

const port = parentPort;

port.on('message', (task: BatchFileTask) => {
  void convertForBatch(task).then(
    (result) => port.postMessage(result),
    (error: unknown) => {
      // Defensive: convertForBatch is not supposed to reject, but a rejection here
      // would otherwise hang the pool waiting for a reply that never arrives.
      port.postMessage({
        id: task.id,
        path: task.path,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        elapsedMs: 0,
      });
    }
  );
});
