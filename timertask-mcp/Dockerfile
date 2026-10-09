FROM node:22.23.3-bookworm-slim AS gateway
RUN npm install --global --omit=dev --no-audit --no-fund supergateway@4.1.0

FROM container-registry.oracle.com/database/sqlcl@sha256:e0bddbcdfda9b2d83ce91af74c3f5ed71768ad29bbcd5523da837c4051056a54

COPY --from=gateway /usr/local/bin/node /usr/local/bin/node
COPY --from=gateway /usr/local/lib/node_modules/supergateway /opt/supergateway

WORKDIR /opt/mcp
COPY entrypoint.sh sql-session.sh sql-session.mjs /opt/mcp/
RUN chmod 0755 /opt/mcp/entrypoint.sh /opt/mcp/sql-session.sh \
    && mkdir -p /opt/mcp/logs

ENV MCP_PORT=9001
EXPOSE 9001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:9001/healthz || exit 1

ENTRYPOINT ["/bin/bash", "/opt/mcp/entrypoint.sh"]
