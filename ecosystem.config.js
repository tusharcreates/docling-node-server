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
      },
    },
  ],
};
