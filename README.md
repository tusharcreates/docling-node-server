# Docling PDF Text Worker

Small Node.js + TypeScript service that exposes a route for converting a PDF URL into a downloadable `.txt` file.

Docling is Python-only, so the Node server starts a long-lived Python worker pool. Each worker constructs a Docling `DocumentConverter`, warms the PDF pipeline once with `initialize_pipeline(InputFormat.PDF)`, then handles conversion requests over newline-delimited JSON.

By default the pool starts one worker and gives it all available CPU threads. This is the fastest shape for single-PDF latency. For higher throughput across many simultaneous PDFs, set `DOCLING_WORKERS` to the number of Python workers you want; CPU threads are divided across those workers unless `DOCLING_THREADS_PER_WORKER` is set explicitly.

## Setup

```bash
npm install
python3 -m venv .venv
.venv/bin/pip install -r python/requirements.txt
```

## Run

```bash
PYTHON=.venv/bin/python npm run dev
```

The service listens on `http://localhost:3000` by default (port `8000` when deployed via PM2).

## Routes

### Health

```bash
curl http://localhost:8000/health
```

### Convert PDF URL to Text

```bash
curl -X POST http://localhost:8000/convert/pdf/text \
  -H "content-type: application/json" \
  -d '{"url":"https://arxiv.org/pdf/2408.09869"}' \
  -o output.txt
```

The same route also accepts `GET`:

```bash
curl "http://localhost:8000/convert/pdf/text?url=https%3A%2F%2Farxiv.org%2Fpdf%2F2408.09869" \
  -o output.txt
```

Optional limits:

- `maxNumPages`: maximum pages Docling should process.
- `maxFileSize`: maximum source size in bytes.

## Deploy with PM2

Install PM2 globally if you haven't already:

```bash
npm install -g pm2
```

Build the TypeScript source:

```bash
npm run build
```

Start the service under PM2:

```bash
PYTHON=.venv/bin/python pm2 start dist/server.js --name docling-node-server
```

Useful PM2 commands:

```bash
pm2 status                        # check process status
pm2 logs docling-node-server      # stream logs
pm2 restart docling-node-server   # restart the service
pm2 stop docling-node-server      # stop the service
```

To make the service survive reboots:

```bash
pm2 save
pm2 startup
```

Run the `pm2 startup` output command as instructed (it prints a `sudo env ...` line — copy and run it).

If you need to pass environment variables persistently, create an `ecosystem.config.js` at the project root:

```js
module.exports = {
  apps: [
    {
      name: "docling-node-server",
      script: "dist/server.js",
      env: {
        NODE_ENV: "production",
        PORT: 8000,
        HOST: "0.0.0.0",
        PYTHON: ".venv/bin/python",
        DOCLING_REQUEST_TIMEOUT_MS: 300000,
        DOCLING_WORKERS: 1,
        DOCLING_OCR: "false",
        DOCLING_TABLE_STRUCTURE: "false",
      },
    },
  ],
};
```

Then start with:

```bash
pm2 start ecosystem.config.js
```

## Environment

- `PORT`: HTTP port. Defaults to `3000`.
- `HOST`: HTTP bind host. Defaults to `127.0.0.1`.
- `PYTHON`: Python executable used for the Docling worker. Defaults to `python3`.
- `DOCLING_REQUEST_TIMEOUT_MS`: conversion timeout. Defaults to `300000`.
- `DOCLING_WORKERS`: Python worker count. Defaults to `1` so one PDF can use all CPU threads.
- `DOCLING_THREADS_PER_WORKER`: CPU thread budget per Python worker. Defaults to available CPU threads divided by `DOCLING_WORKERS`.
- `DOCLING_OCR`: enables Docling OCR when set to `true`. Defaults to `false` for faster text extraction from digital PDFs.
- `DOCLING_TABLE_STRUCTURE`: enables Docling table-structure analysis when set to `true`. Defaults to `false` for faster plain-text extraction.

Example throughput profile for a 12-core host with many PDFs in flight:

```bash
DOCLING_WORKERS=4 DOCLING_THREADS_PER_WORKER=3 PYTHON=.venv/bin/python npm run start
```
