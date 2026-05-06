import { availableParallelism } from "node:os";
import { DoclingWorker, DoclingWorkerError, type ConvertPdfOptions } from "./doclingWorker.js";

const cpuCount = availableParallelism();

export type DoclingWorkerPoolStatus = "idle" | "starting" | "ready" | "stopped";

type QueuedConversion = {
  url: string;
  options: ConvertPdfOptions;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
};

export class DoclingWorkerPool {
  private workers: DoclingWorker[];
  private activeWorkers = new Set<DoclingWorker>();
  private queuedConversions: QueuedConversion[] = [];
  private startPromise?: Promise<void>;
  private startingRemaining = false;

  constructor(
    private readonly options: {
      pythonCommand: string;
      scriptPath: string;
      requestTimeoutMs: number;
      concurrency: number;
      threadsPerWorker: number;
    },
  ) {
    this.workers = Array.from(
      { length: options.concurrency },
      () =>
        new DoclingWorker({
          pythonCommand: options.pythonCommand,
          scriptPath: options.scriptPath,
          requestTimeoutMs: options.requestTimeoutMs,
          threadsPerWorker: options.threadsPerWorker,
        }),
    );
  }

  get status(): DoclingWorkerPoolStatus {
    // The pool can serve requests as soon as at least one worker is ready.
    if (this.workers.some((w) => w.status === "ready")) {
      return "ready";
    }
    if (this.workers.every((w) => w.status === "stopped")) {
      return "stopped";
    }
    if (this.workers.some((w) => w.status === "starting")) {
      return "starting";
    }
    return "idle";
  }

  get workerCount(): number {
    return this.workers.length;
  }

  get threadsPerWorker(): number {
    return this.options.threadsPerWorker;
  }

  get busyWorkerCount(): number {
    return this.activeWorkers.size;
  }

  get queuedCount(): number {
    return this.queuedConversions.length;
  }

  /**
   * Starts workers sequentially so ML model loading is staggered.
   * The first worker resolves as soon as it is ready so callers can begin
   * serving requests immediately; remaining workers continue warming up in
   * the background.
   */
  async start(): Promise<void> {
    if (this.status === "ready") {
      return;
    }

    this.startPromise ??= this.startUntilOneWorkerIsReady().finally(() => {
      this.startPromise = undefined;
    });

    await this.startPromise;
  }

  private async startUntilOneWorkerIsReady(): Promise<void> {
    let lastError: Error | undefined;

    for (let i = 0; i < this.workers.length; i++) {
      try {
        await this.workers[i].start();
        this.drainQueue();
        void this.startRemaining(i + 1);
        return;
      } catch (error) {
        lastError = toError(error);
        console.error(`Docling worker ${i} failed to start: ${lastError.message}`);
      }
    }

    const error = lastError ?? new DoclingWorkerError("No Docling workers are configured");
    this.rejectQueued(error);
    throw error;
  }

  private async startRemaining(startIndex: number): Promise<void> {
    if (this.startingRemaining) {
      return;
    }

    this.startingRemaining = true;
    try {
      for (let i = startIndex; i < this.workers.length; i++) {
        try {
          await this.workers[i].start();
          this.drainQueue();
        } catch (error) {
          console.error(`Docling worker ${i} failed to start: ${toError(error).message}`);
        }
      }
    } finally {
      this.startingRemaining = false;
    }
  }

  stop(): void {
    this.rejectQueued(new DoclingWorkerError("Docling worker pool stopped"));
    for (const worker of this.workers) {
      worker.stop();
    }
  }

  async convertPdfUrlToText(url: string, options: ConvertPdfOptions = {}): Promise<string> {
    const response = new Promise<string>((resolve, reject) => {
      this.queuedConversions.push({ url, options, resolve, reject });
    });

    this.drainQueue();

    return response;
  }

  private drainQueue(): void {
    while (this.queuedConversions.length > 0) {
      const worker = this.idleReadyWorker();
      if (!worker) {
        if (!this.hasReadyWorker()) {
          this.startForQueuedWork();
        }
        return;
      }

      const conversion = this.queuedConversions.shift();
      if (!conversion) {
        return;
      }

      this.runConversion(worker, conversion);
    }
  }

  private idleReadyWorker(): DoclingWorker | undefined {
    return this.workers.find(
      (worker) =>
        worker.status === "ready" && worker.pendingCount === 0 && !this.activeWorkers.has(worker),
    );
  }

  private hasReadyWorker(): boolean {
    return this.workers.some((worker) => worker.status === "ready");
  }

  private startForQueuedWork(): void {
    void this.start()
      .then(() => this.drainQueue())
      .catch((error: unknown) => this.rejectQueued(toError(error)));
  }

  private runConversion(worker: DoclingWorker, conversion: QueuedConversion): void {
    this.activeWorkers.add(worker);

    void worker
      .convertPdfUrlToText(conversion.url, conversion.options)
      .then(conversion.resolve)
      .catch(conversion.reject)
      .finally(() => {
        this.activeWorkers.delete(worker);
        this.drainQueue();
      });
  }

  private rejectQueued(error: Error): void {
    while (this.queuedConversions.length > 0) {
      this.queuedConversions.shift()?.reject(error);
    }
  }
}

export function createWorkerPool(options: {
  pythonCommand: string;
  scriptPath: string;
  requestTimeoutMs: number;
}): DoclingWorkerPool {
  const concurrency = resolveConcurrency();
  const threadsPerWorker = resolveThreadsPerWorker(concurrency);
  console.log(
    `Docling worker pool: starting ${concurrency} worker(s) with ${threadsPerWorker} thread(s) each`,
  );
  return new DoclingWorkerPool({ ...options, concurrency, threadsPerWorker });
}

function resolveConcurrency(): number {
  const env = process.env.DOCLING_WORKERS;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isInteger(n) && n >= 1) {
      return n;
    }
    console.warn(`DOCLING_WORKERS="${env}" is not a positive integer; falling back to 1`);
  }
  return 1;
}

function resolveThreadsPerWorker(concurrency: number): number {
  const env = process.env.DOCLING_THREADS_PER_WORKER;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isInteger(n) && n >= 1) {
      return n;
    }
    console.warn(
      `DOCLING_THREADS_PER_WORKER="${env}" is not a positive integer; falling back to auto`,
    );
  }
  // Spread available cores evenly across workers, with at least 1 thread each.
  return Math.max(1, Math.floor(cpuCount / concurrency));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
