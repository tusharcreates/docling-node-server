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
