import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DoclingWorkerError } from "./doclingWorker.js";
import { createWorkerPool } from "./doclingWorkerPool.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = join(__dirname, "..");

const port = Number(process.env.PORT ?? 8000);
const host = process.env.HOST ?? "127.0.0.1";
const requestTimeoutMs = Number(process.env.DOCLING_REQUEST_TIMEOUT_MS ?? 5 * 60 * 1000);

const worker = createWorkerPool({
  pythonCommand: process.env.PYTHON ?? "python3",
  scriptPath: join(projectRoot, "python", "docling_worker.py"),
  requestTimeoutMs,
});

type PdfTextRequestBody = {
  url?: unknown;
  maxNumPages?: unknown;
  maxFileSize?: unknown;
};

type RouteContext = {
  url: URL;
  request: IncomingMessage;
  response: ServerResponse;
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      sendJson(response, 200, {
        ok: worker.status === "ready",
        doclingWorker: worker.status,
        workers: worker.workerCount,
        busyWorkers: worker.busyWorkerCount,
        queuedRequests: worker.queuedCount,
        threadsPerWorker: worker.threadsPerWorker,
      });
      return;
    }

    if (url.pathname === "/convert/pdf/text" && request.method === "POST") {
      await handlePostConvert({ url, request, response });
      return;
    }

    if (url.pathname === "/convert/pdf/text" && request.method === "GET") {
      await handleGetConvert({ url, request, response });
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    handleError(response, error);
  }
});

server.listen(port, host, () => {
  console.log(`Docling PDF text worker listening on http://${host}:${port}`);
});

void worker.start().catch((error) => {
  console.error(`Docling worker failed to warm up: ${error.message}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function handlePostConvert({ request, response }: RouteContext): Promise<void> {
  const body = await readJsonBody<PdfTextRequestBody>(request);
  const pdfUrl = requireHttpUrl(body.url);
  const maxNumPages = optionalPositiveNumber(body.maxNumPages, "maxNumPages");
  const maxFileSize = optionalPositiveNumber(body.maxFileSize, "maxFileSize");

  await sendConvertedText(response, pdfUrl, { maxNumPages, maxFileSize });
}

async function handleGetConvert({ url, response }: RouteContext): Promise<void> {
  const pdfUrl = requireHttpUrl(url.searchParams.get("url"));
  const maxNumPages = optionalPositiveNumber(url.searchParams.get("maxNumPages"), "maxNumPages");
  const maxFileSize = optionalPositiveNumber(url.searchParams.get("maxFileSize"), "maxFileSize");

  await sendConvertedText(response, pdfUrl, { maxNumPages, maxFileSize });
}

async function sendConvertedText(
  response: ServerResponse,
  pdfUrl: string,
  options: {
    maxNumPages?: number;
    maxFileSize?: number;
  },
): Promise<void> {
  const text = await worker.convertPdfUrlToText(pdfUrl, options);
  const filename = filenameForPdfUrl(pdfUrl);

  response.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
  });
  response.end(text);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const maxBytes = 1024 * 1024;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;

    if (totalBytes > maxBytes) {
      throw new HttpError(413, "request body is too large");
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new HttpError(400, "request body must be JSON");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
}

function requireHttpUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "url must be a non-empty string");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, "url must be an absolute http(s) URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, "url must use http or https");
  }

  return parsed.toString();
}

function optionalPositiveNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, `${name} must be a positive integer`);
  }

  return parsed;
}

function filenameForPdfUrl(pdfUrl: string): string {
  const parsed = new URL(pdfUrl);
  const rawName = basename(decodeURIComponent(parsed.pathname)) || "document";
  const withoutPdf = rawName.replace(/\.pdf$/i, "") || "document";
  const safeName = withoutPdf.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");

  return `${safeName || "document"}.txt`;
}

function handleError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }

  if (error instanceof HttpError) {
    sendJson(response, error.statusCode, { error: error.message });
    return;
  }

  if (error instanceof DoclingWorkerError) {
    sendJson(response, 502, { error: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : "internal server error";
  console.error(error);
  sendJson(response, 500, { error: message });
}

function shutdown(): void {
  worker.stop();
  server.close(() => {
    process.exit(0);
  });
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
