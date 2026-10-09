#!/usr/bin/env bash
set -euo pipefail

port="${MCP_PORT:-9001}"

exec /usr/local/bin/node /opt/supergateway/dist/index.js \
  --stdio "/opt/mcp/sql-session.sh" \
  --outputTransport streamableHttp \
  --stateful \
  --sessionTimeout "${MCP_SESSION_TIMEOUT_MS:-1800000}" \
  --logLevel none \
  --port "$port" \
  --host 0.0.0.0 \
  --healthEndpoint /healthz
