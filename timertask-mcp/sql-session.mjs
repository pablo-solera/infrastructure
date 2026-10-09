import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const allowedTools = new Set([
  "connections_list",
  "connect",
  "disconnect",
  "sql_run",
  "schema_information",
  "request_status",
]);

const template = process.env.DBTOOLS_TEMPLATE ?? "/opt/mcp/dbtools-template";
const logs = process.env.MCP_LOG_DIR ?? "/opt/mcp/logs";
const sessionHome = await mkdtemp(join(tmpdir(), "timertask-mcp-session-"));
const dbtoolsHome = join(sessionHome, ".dbtools");
let child;
let shuttingDown = false;
const pendingConnects = new Map();
const pendingSchemaSet = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function relayFromSqlcl(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write(`Unexpected SQLcl stdout (not forwarded): ${line}\n`);
    return;
  }

  if (Array.isArray(message?.result?.tools)) {
    message.result.tools = message.result.tools.filter((tool) => allowedTools.has(tool.name));
  }

  const responseId = JSON.stringify(message?.id);
  const pendingSchemaRequest = pendingSchemaSet.get(responseId);
  if (pendingSchemaRequest) {
    pendingSchemaSet.delete(responseId);
    if (message.error || message.result?.isError) {
      send({
        jsonrpc: "2.0",
        id: pendingSchemaRequest.id,
        error: {
          code: -32000,
          message: "Connected to Oracle, but could not set CURRENT_SCHEMA to TIMERTASK_ES",
          data: message.error ?? message.result,
        },
      });
    } else {
      send(pendingSchemaRequest.connectResponse);
    }
    return;
  }

  const pendingConnect = pendingConnects.get(responseId);
  if (pendingConnect) {
    pendingConnects.delete(responseId);
    if (message.error || message.result?.isError) {
      send(message);
      return;
    }

    const schemaRequestId = `timertask-set-schema-${crypto.randomUUID()}`;
    pendingSchemaSet.set(JSON.stringify(schemaRequestId), {
      id: pendingConnect.id,
      connectResponse: message,
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: schemaRequestId,
      method: "tools/call",
      params: {
        name: "sql_run",
        arguments: { sql: "ALTER SESSION SET CURRENT_SCHEMA=TIMERTASK_ES" },
      },
    })}\n`);
    return;
  }

  send(message);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
    await once(child, "exit").catch(() => {});
  }
}

try {
  const templateStat = await stat(template).catch(() => null);
  if (!templateStat?.isDirectory()) {
    throw new Error(`SQLcl connection directory is missing: ${template}`);
  }

  await mkdir(logs, { recursive: true });
  await mkdir(dbtoolsHome, { recursive: true });
  await cp(template, dbtoolsHome, { recursive: true });
  await chmod(dbtoolsHome, 0o700);

  const env = { ...process.env, HOME: sessionHome };
  child = spawn("/opt/oracle/sqlcl/bin/sql", ["-home", dbtoolsHome, "-mcp"], {
    cwd: "/opt/mcp",
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });

  const sqlclOutput = createInterface({ input: child.stdout });
  sqlclOutput.on("line", relayFromSqlcl);

  const clientInput = createInterface({ input: process.stdin });
  clientInput.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write("Invalid MCP request JSON (not forwarded)\n");
      return;
    }

    if (message?.method === "tools/call" && !allowedTools.has(message.params?.name)) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Tool is not exposed by this MCP service" },
      });
      return;
    }
    if (message?.method === "tools/call" && message.params?.name === "connect") {
      if (message.params?.arguments?.connection_name !== "timertask") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: "Only the 'timertask' connection is enabled" },
        });
        return;
      }
      pendingConnects.set(JSON.stringify(message.id), { id: message.id });
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });

  clientInput.on("close", () => {
    if (child?.stdin.writable) child.stdin.end();
  });

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));

  child.on("error", (error) => {
    process.stderr.write(`Unable to start SQLcl MCP: ${error.message}\n`);
    process.exitCode = 1;
  });

  const [exitCode, signal] = await once(child, "exit");
  sqlclOutput.close();
  process.exitCode = typeof exitCode === "number" ? exitCode : signal ? 1 : 0;

  const logSource = join(dbtoolsHome, "mcp.log");
  const logStat = await stat(logSource).catch(() => null);
  if (logStat?.isFile()) {
    const safeTimestamp = new Date().toISOString().replaceAll(":", "-");
    await cp(logSource, join(logs, `sqlcl-${safeTimestamp}-${process.pid}.log`)).catch(() => {});
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await rm(sessionHome, { recursive: true, force: true }).catch(() => {});
}
