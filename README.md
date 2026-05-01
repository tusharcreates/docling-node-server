# Docling PDF Text Worker

Small Node.js + TypeScript service that exposes a route for converting a PDF URL into a downloadable `.txt` file.

Docling is Python-only, so the Node server starts one long-lived Python child process. That process constructs a single Docling `DocumentConverter`, warms the PDF pipeline once with `initialize_pipeline(InputFormat.PDF)`, then handles all conversion requests over newline-delimited JSON.

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

The service listens on `http://localhost:3000` by default.

## Routes

### Health

```bash
curl http://localhost:3000/health
```

### Convert PDF URL to Text

```bash
curl -X POST http://localhost:3000/convert/pdf/text \
  -H "content-type: application/json" \
  -d '{"url":"https://arxiv.org/pdf/2408.09869"}' \
  -o output.txt
```

The same route also accepts `GET`:

```bash
curl "http://localhost:3000/convert/pdf/text?url=https%3A%2F%2Farxiv.org%2Fpdf%2F2408.09869" \
  -o output.txt
```

Optional limits:

- `maxNumPages`: maximum pages Docling should process.
- `maxFileSize`: maximum source size in bytes.

## Environment

- `PORT`: HTTP port. Defaults to `3000`.
- `HOST`: HTTP bind host. Defaults to `127.0.0.1`.
- `PYTHON`: Python executable used for the Docling worker. Defaults to `python3`.
- `DOCLING_REQUEST_TIMEOUT_MS`: conversion timeout. Defaults to `300000`.
