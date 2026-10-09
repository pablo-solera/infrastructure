# SQLcl MCP for TIMERTASK

Publishes Oracle SQLcl MCP over Streamable HTTP for OpenCode. Traefik routes
`http://accionaplus-peuwaxprvdacc03.axadmin.net/mcp` to this service on port
9001. It is intended for the internal network and has no MCP API key, matching
the Jira MCP deployment.

## What is exposed

The gateway exposes SQLcl MCP's `connections_list`, `connect`, `disconnect`,
`sql_run`, `schema_information`, and `request_status` tools. `sql_run` supports
standard SQL queries and PL/SQL, including SELECT queries against Oracle data
dictionary views. `sqlcl_run`, `skills_sync`, and `annotation_generate` are
removed from `tools/list` and rejected if called directly.

The connection is saved as `timertask`. After a successful `connect`, the
session wrapper runs `ALTER SESSION SET CURRENT_SCHEMA=TIMERTASK_ES` before
returning the connection result to the client. This selects the default schema
only; it does not prevent the shared database account from reading other
schemas to which it already has grants. Actual access remains governed by
Oracle privileges for `ESDFZO`.

Each Streamable HTTP session gets a separate SQLcl process and a temporary
DBTools home. Its MCP audit log is copied to `./logs` when the session ends.
Idle sessions time out after 30 minutes. Container memory is capped at 4 GiB.

## Server setup

Run these commands from this directory:

```sh
cp .env.example .env
mkdir -p data/dbtools logs
```

Create the saved connection interactively so its password is not put in shell
history, the Compose file, or this repository:

```sh
docker run --rm -it \
  --entrypoint /opt/oracle/sqlcl/bin/sql \
  -v "$PWD/data/dbtools:/root/.dbtools" \
  mcp/timertask-sqlcl:26.2.0 /nolog
```

At the SQLcl prompt, enter:

```text
conn -save timertask -savepwd esdfzo@192.168.5.178:1521/PAXEI.AUDATEX.ES
exit
```

If `conn` prompts for the password, enter it there. Confirm `data/dbtools`
contains the saved `timertask` connection, then start the service:

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 mcp-timertask
```

The Compose service joins the existing external Docker network `acciona`; it
does not publish a host port. Traefik routes the hostname to container port
9001 through the `web` entrypoint, matching `jira-mcp`.

## OpenCode client configuration

Add the following MCP entry to OpenCode's configuration:

```jsonc
"sqlcl": {
  "type": "remote",
  "url": "http://accionaplus-peuwaxprvdacc03.axadmin.net/mcp",
  "enabled": true,
  "timeout": 60000
}
```

## Local smoke test

Build the image and run it on loopback, using a local saved DBTools connection
directory mounted read-only. Do not copy connection files into this repository.

Use the included smoke test against `http://127.0.0.1:9001/mcp`. It calls
`connections_list`, connects to `timertask`, verifies the allowed/blocked tools,
checks `CURRENT_SCHEMA`, and runs a version query. Stop the test container
beforehand if you already started it manually; then run:

```sh
docker run --rm --name mcp-timertask-local \
  -p 127.0.0.1:9001:9001 \
  -e MCP_SESSION_TIMEOUT_MS=120000 \
  -v /absolute/path/to/local/dbtools:/opt/mcp/dbtools-template:ro \
  -v "$PWD/logs:/opt/mcp/logs" \
  mcp/timertask-sqlcl:26.2.0
```

In another terminal, run `node smoke-test.mjs`.

The output includes the detected Oracle database version. Check
`docker exec mcp-timertask-local ps -ef` while two clients are connected to
confirm separate SQLcl processes.

## Operational notes

- Image is published as `pablosla/timertask-mcp:1.0.0`. The SQLcl base is pinned to digest
  `sha256:e0bddbcdfda9b2d83ce91af74c3f5ed71768ad29bbcd5523da837c4051056a54`
  (SQLcl 26.2.0.181.2110); Supergateway is pinned to 4.1.0.
- SQLcl's `mcp.log` is copied to `./logs` when its client session exits. The
  temporary per-session DBTools home is then removed.
- Logs include SQLcl's MCP audit records and must be handled as internal data.
- There is no authentication on the MCP endpoint. Restrict access to the
  internal network using the existing network and firewall policy.
- A read-only Oracle account is still required for read-only behavior. Hiding
  `run-sqlcl` only removes SQLcl-specific commands; Oracle grants determine what
  `run-sql` can access or modify.
