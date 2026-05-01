import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

export type DoclingWorkerStatus = "idle" | "starting" | "ready" | "stopped";

export type ConvertPdfOptions = {
  maxNumPages?: number;
  maxFileSize?: number;
};

type WorkerRequest = ConvertPdfOptions & {
  id: string;
  url: string;
};

type PendingRequest = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type WorkerMessage =
  | { type: "ready" }
  | { type: "fatal"; error?: string }
  | { id?: string; ok?: boolean; text?: string; error?: string };

export class DoclingWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoclingWorkerError";
  }
}

export class DoclingWorker {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, PendingRequest>();
  private startPromise?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private currentStatus: DoclingWorkerStatus = "idle";

  constructor(
    private readonly options: {
      pythonCommand: string;
      scriptPath: string;
      requestTimeoutMs: number;
    },
  ) {}

  get status(): DoclingWorkerStatus {
    return this.currentStatus;
  }

  async convertPdfUrlToText(url: string, options: ConvertPdfOptions = {}): Promise<string> {
    await this.start();

    if (!this.child || this.child.stdin.destroyed) {
      throw new DoclingWorkerError("Docling worker is not available");
    }

    const id = randomUUID();
    const request: WorkerRequest = { id, url, ...options };

    const response = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new DoclingWorkerError("Docling conversion timed out"));
      }, this.options.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
    });

    this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
      if (!error) {
        return;
      }

      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.reject(error);
    });

    return response;
  }

  async start(): Promise<void> {
    if (this.currentStatus === "ready") {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.currentStatus = "starting";
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;

      this.child = spawn(this.options.pythonCommand, ["-u", this.options.scriptPath], {
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdout = createInterface({ input: this.child.stdout });
      const stderr = createInterface({ input: this.child.stderr });

      stdout.on("line", (line) => this.handleStdoutLine(line));
      stderr.on("line", (line) => {
        console.error(`[docling-python] ${line}`);
      });

      this.child.once("error", (error) => {
        this.failStartup(error);
        this.rejectPending(error);
      });

      this.child.once("exit", (code, signal) => {
        const error = new DoclingWorkerError(
          `Docling worker exited${code === null ? "" : ` with code ${code}`}${
            signal ? ` and signal ${signal}` : ""
          }`,
        );
        this.currentStatus = "stopped";
        this.startPromise = undefined;
        this.child = undefined;
        this.failStartup(error);
        this.rejectPending(error);
      });
    });

    return this.startPromise;
  }

  stop(): void {
    if (!this.child) {
      return;
    }

    this.child.kill();
  }

  private handleStdoutLine(line: string): void {
    let message: WorkerMessage;

    try {
      message = JSON.parse(line) as WorkerMessage;
    } catch {
      console.warn(`[docling-python] ignored non-json stdout: ${line}`);
      return;
    }

    if ("type" in message && message.type === "ready") {
      this.currentStatus = "ready";
      this.readyResolve?.();
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }

    if ("type" in message && message.type === "fatal") {
      const error = new DoclingWorkerError(message.error ?? "Docling worker failed to start");
      this.failStartup(error);
      this.rejectPending(error);
      return;
    }

    if (!message.id) {
      console.warn("[docling-python] ignored response without id");
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      console.warn(`[docling-python] ignored response for unknown id: ${message.id}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.ok && typeof message.text === "string") {
      pending.resolve(message.text);
      return;
    }

    pending.reject(new DoclingWorkerError(message.error ?? "Docling conversion failed"));
  }

  private failStartup(error: Error): void {
    if (this.currentStatus === "starting") {
      this.currentStatus = "stopped";
    }

    this.readyReject?.(error);
    this.readyResolve = undefined;
    this.readyReject = undefined;
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
