import type { ColorEditPlan, ImageAnalysis, VectorizeOptions } from '@perfectvector/core';
import type { ExportFormat, TraceSummary, WorkerRequest, WorkerResponse } from '@/worker/protocol';

/**
 * Promise wrapper around the vectorization worker.
 *
 * Beyond the usual request/response plumbing this handles one thing that matters
 * for feel: **superseding**. Dragging a slider fires a request per frame, and
 * tracing takes longer than a frame, so requests queue up and the UI ends up
 * showing a result from several drags ago. Any pending request of the same kind is
 * therefore rejected as superseded, and only the newest answer is used.
 */
export class VectorizerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: WorkerResponse) => void; reject: (error: Error) => void; kind: string }
  >();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    // The URL form is what lets the bundler emit the worker as its own chunk.
    const worker = new Worker(new URL('../worker/vectorize.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const entry = this.pending.get(event.data.id);
      if (!entry) return;
      this.pending.delete(event.data.id);
      entry.resolve(event.data);
    };

    worker.onerror = (event) => {
      const message = event.message || 'The vectorizer worker crashed.';
      for (const [, entry] of this.pending) entry.reject(new Error(message));
      this.pending.clear();
    };

    this.worker = worker;
    return worker;
  }

  private send(request: WorkerRequest, transfer: Transferable[] = []): Promise<WorkerResponse> {
    const worker = this.ensureWorker();

    // Cancel anything of the same kind that has not answered yet.
    for (const [id, entry] of this.pending) {
      if (entry.kind === request.type) {
        this.pending.delete(id);
        entry.reject(new SupersededError());
      }
    }

    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject, kind: request.type });
      worker.postMessage(request, transfer);
    });
  }

  async load(image: { width: number; height: number; data: Uint8ClampedArray }): Promise<ImageAnalysis> {
    // Copy first: the buffer is transferred, and the caller may still need its own.
    const pixels = image.data.slice().buffer;
    const response = await this.send(
      { id: this.nextId++, type: 'load', width: image.width, height: image.height, pixels },
      [pixels]
    );
    if (!response.ok) throw new Error(response.error);
    if (response.type !== 'load') throw new Error('Unexpected worker reply.');
    return response.analysis;
  }

  async trace(options: VectorizeOptions): Promise<TraceSummary> {
    const response = await this.send({ id: this.nextId++, type: 'trace', options });
    if (!response.ok) throw new Error(response.error);
    if (response.type !== 'trace') throw new Error('Unexpected worker reply.');
    return response.summary;
  }

  async edit(plan: ColorEditPlan, exact: boolean): Promise<TraceSummary> {
    const response = await this.send({ id: this.nextId++, type: 'edit', plan, exact });
    if (!response.ok) throw new Error(response.error);
    if (response.type !== 'edit') throw new Error('Unexpected worker reply.');
    return response.summary;
  }

  async export(format: ExportFormat): Promise<string> {
    const response = await this.send({ id: this.nextId++, type: 'export', format });
    if (!response.ok) throw new Error(response.error);
    if (response.type !== 'export') throw new Error('Unexpected worker reply.');
    return response.text;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}

/** Thrown when a newer request of the same kind replaced this one. */
export class SupersededError extends Error {
  constructor() {
    super('superseded');
    this.name = 'SupersededError';
  }
}

export function isSuperseded(error: unknown): boolean {
  return error instanceof Error && error.name === 'SupersededError';
}
