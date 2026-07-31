import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';

/**
 * A small worker_threads pool.
 *
 * Batch conversion needs real threads rather than `Promise.all`. Tracing is
 * synchronous, CPU-bound JavaScript — measured at 210-1356ms per image against
 * 1-7ms to decode it — so concurrent promises would run it strictly one after
 * another on the same thread and finish no faster.
 *
 * Work is pulled from a shared queue rather than split across workers up front.
 * The per-image cost varies by more than two orders of magnitude (5ms for a 32px
 * sprite, 1370ms for a photograph), so any static partition leaves most threads
 * idle while one grinds through the slow files.
 */

export interface PoolOptions {
  /** Module URL of the worker script. */
  workerUrl: URL;
  /** Maximum concurrent workers. Clamped to the queue length and the core count. */
  size: number;
  /** Milliseconds after which a single task is abandoned. */
  taskTimeoutMs?: number;
}

interface Pending<TTask, TResult> {
  task: TTask;
  resolve: (result: TResult) => void;
  reject: (error: Error) => void;
}

const DEFAULT_TASK_TIMEOUT_MS = 120_000;

/** Leave a core for the parent process and the OS. */
export function defaultPoolSize(): number {
  return Math.max(1, availableParallelism() - 1);
}

export async function runPool<TTask, TResult>(
  tasks: TTask[],
  options: PoolOptions,
  onResult?: (result: TResult) => void
): Promise<TResult[]> {
  if (tasks.length === 0) return [];

  const size = Math.max(1, Math.min(options.size, tasks.length, defaultPoolSize()));
  const timeout = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

  const queue: Array<Pending<TTask, TResult>> = [];
  const results: TResult[] = [];

  const settled = new Promise<void>((resolveAll, rejectAll) => {
    let remaining = tasks.length;
    let failed = false;

    for (const task of tasks) {
      queue.push({
        task,
        resolve: (result) => {
          results.push(result);
          onResult?.(result);
          if (--remaining === 0 && !failed) resolveAll();
        },
        reject: (error) => {
          failed = true;
          rejectAll(error);
        },
      });
    }

    const workers: Worker[] = [];

    /** Hand the next queued task to a worker, or retire it if the queue is empty. */
    const pump = (worker: Worker): void => {
      const next = queue.shift();
      if (!next) {
        void worker.terminate();
        return;
      }

      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        worker.removeAllListeners('message');
        worker.removeAllListeners('error');
      };

      const finish = (result: TResult) => {
        cleanup();
        next.resolve(result);
        pump(worker);
      };

      worker.once('message', (message: TResult) => finish(message));

      worker.once('error', (error: Error) => {
        cleanup();
        // A crashed worker cannot be reused, and its task is lost. Reporting the
        // failure for that one file and continuing is far more useful in a batch
        // than aborting the whole run.
        next.resolve({
          ...(next.task as object),
          status: 'failed',
          reason: `worker crashed: ${error.message}`,
        } as unknown as TResult);
        void worker.terminate();
        spawn();
      });

      timer = setTimeout(() => {
        cleanup();
        next.resolve({
          ...(next.task as object),
          status: 'failed',
          reason: `timed out after ${timeout}ms`,
        } as unknown as TResult);
        void worker.terminate();
        spawn();
      }, timeout);

      worker.postMessage(next.task);
    };

    const spawn = (): void => {
      // Nothing left to do, so do not pay to start another thread.
      if (queue.length === 0) return;
      const worker = new Worker(options.workerUrl);
      workers.push(worker);
      pump(worker);
    };

    for (let i = 0; i < size; i++) spawn();
  });

  await settled;
  return results;
}
