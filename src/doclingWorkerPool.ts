import { availableParallelism } from "node:os";
import { DoclingWorker, type ConvertPdfOptions, type DoclingWorkerStatus } from "./doclingWorker.js";

const cpuCount = availableParallelism();

export type DoclingWorkerPoolStatus = "idle" | "starting" | "ready" | "stopped";

export class DoclingWorkerPool {
  private workers: DoclingWorker[];
  private currentStatus: DoclingWorkerPoolStatus = "idle";

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

  get status(): DoclingWorkerStatus {
    if (this.workers.every((w) => w.status === "ready")) {
      return "ready";
    }
    if (this.workers.every((w) => w.status === "stopped")) {
      return "stopped";
    }
    if (this.workers.some((w) => w.status === "starting")) {
      return "starting";
    }
    // At least one worker ready — pool is usable
    if (this.workers.some((w) => w.status === "ready")) {
      return "ready";
    }
    return "idle";
  }

  async start(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.start()));
  }

  stop(): void {
    for (const worker of this.workers) {
      worker.stop();
    }
  }

  async convertPdfUrlToText(url: string, options: ConvertPdfOptions = {}): Promise<string> {
    const worker = this.leastBusyWorker();
    return worker.convertPdfUrlToText(url, options);
  }

  private leastBusyWorker(): DoclingWorker {
    const ready = this.workers.filter((w) => w.status === "ready");
    const pool = ready.length > 0 ? ready : this.workers;

    let best = pool[0];
    for (let i = 1; i < pool.length; i++) {
      if (pool[i].pendingCount < best.pendingCount) {
        best = pool[i];
      }
    }
    return best;
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
    console.warn(`DOCLING_WORKERS="${env}" is not a positive integer; falling back to CPU count`);
  }
  return cpuCount;
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
