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
const pendingCompatSchema = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function resultText(message) {
  return message?.result?.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n") ?? "";
}

function sendSchemaResult(id, text, isError = false) {
  send({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], isError },
  });
}

function sendSchemaQuery(state, sql) {
  const id = `timertask-schema-${crypto.randomUUID()}`;
  state.awaiting = JSON.stringify(id);
  pendingCompatSchema.set(state.awaiting, state);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "sql_run", arguments: { sql } },
  })}\n`);
}

function tableFilterSql(state) {
  const predicates = [
    `t.owner = ${sqlLiteral(state.schema)}`,
    `t.object_name LIKE ${sqlLiteral(state.filter)}`,
  ];
  if (state.objects.length > 0) {
    predicates.push(`t.object_name IN (${state.objects.map(sqlLiteral).join(", ")})`);
  }
  predicates.push(state.level === "DETAILED" ? "t.object_type IN ('TABLE', 'VIEW')" : "t.object_type = 'TABLE'");
  return predicates.join(" AND ");
}

function startCompatibleSchemaInfo(request) {
  const args = request.params?.arguments ?? {};
  const level = String(args.level ?? "BRIEF").toUpperCase();
  if (level === "BRIEF") return false;
  if (!["OVERVIEW", "DETAILED", "TABLE_DETAILS"].includes(level)) {
    sendSchemaResult(request.id, `Unsupported schema_information level: ${level}`, true);
    return true;
  }

  const schema = String(args.schema ?? "TIMERTASK_ES").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_$#]{0,127}$/.test(schema)) {
    sendSchemaResult(request.id, "Invalid schema name", true);
    return true;
  }

  const filter = String(args.filter ?? "%");
  if (filter.length > 128) {
    sendSchemaResult(request.id, "Schema object filter is too long", true);
    return true;
  }

  const rawObjects = args.objects_list ?? "";
  const objects = (Array.isArray(rawObjects) ? rawObjects : String(rawObjects).split(","))
    .map((name) => String(name).trim().toUpperCase())
    .filter(Boolean);
  if (objects.some((name) => !/^[A-Z][A-Z0-9_$#]{0,127}$/.test(name))) {
    sendSchemaResult(request.id, "Invalid object name in objects_list", true);
    return true;
  }

  const state = {
    requestId: request.id,
    level,
    schema,
    filter,
    objects,
    tables: [],
    stage: "tables",
  };
  const sql = `SELECT t.object_name AS table_name, t.object_type, NVL(c.comments, '') AS comments\n` +
    `FROM all_objects t LEFT JOIN all_tab_comments c\n` +
    `  ON c.owner = t.owner AND c.table_name = t.object_name\n` +
    `WHERE ${tableFilterSql(state)}\n` +
    `ORDER BY t.object_name`;
  sendSchemaQuery(state, sql);
  return true;
}

function completeCompatibleSchemaInfo(state) {
  const lines = [
    `Schema information for ${state.schema} (Oracle 11g compatible)`,
    `${state.level === "DETAILED" ? "Objects" : "Tables"} found: ${state.tables.length}`,
  ];

  if (state.tables.length === 0) {
    lines.push("No accessible tables matched the requested schema and filters.");
    sendSchemaResult(state.requestId, lines.join("\n"));
    return;
  }

  if (state.level === "OVERVIEW") {
    for (const table of state.tables) {
      lines.push(`- ${table.type} ${table.name}${table.comment ? ` — ${table.comment}` : ""}`);
    }
    sendSchemaResult(state.requestId, lines.join("\n"));
    return;
  }

  const columnsByTable = new Map();
  for (const column of state.columns) {
    const columns = columnsByTable.get(column.table) ?? [];
    columns.push(column);
    columnsByTable.set(column.table, columns);
  }

  const constraintsByTable = new Map();
  for (const constraint of state.constraints) {
    const key = `${constraint.table}\0${constraint.name}`;
    const item = constraintsByTable.get(key) ?? {
      table: constraint.table,
      name: constraint.name,
      type: constraint.type,
      columns: [],
      references: [],
      targetTable: constraint.targetTable,
    };
    item.columns.push(constraint.column);
    if (constraint.targetTable) item.references.push(constraint.referencedColumn);
    constraintsByTable.set(key, item);
  }

  const constraintLabels = { P: "PRIMARY KEY", U: "UNIQUE", R: "FOREIGN KEY" };
  for (const table of state.tables) {
    lines.push("", `${table.type} ${table.name}`);
    if (table.comment) lines.push(`  Description: ${table.comment}`);
    lines.push("  Columns:");
    for (const column of columnsByTable.get(table.name) ?? []) {
      let type = column.type;
      if (type === "NUMBER" && column.precision) {
        type += `(${column.precision}${column.scale ? `,${column.scale}` : ""})`;
      } else if (["CHAR", "VARCHAR2", "NCHAR", "NVARCHAR2", "RAW"].includes(type) && column.length) {
        type += `(${column.length})`;
      }
      lines.push(`    - ${column.name} ${type}${column.nullable === "N" ? " NOT NULL" : ""}`);
    }

    const constraints = [...constraintsByTable.values()].filter((item) => item.table === table.name);
    if (constraints.length > 0) {
      lines.push("  Constraints:");
      for (const constraint of constraints) {
        let description = `    - ${constraintLabels[constraint.type] ?? "CONSTRAINT"} ${constraint.name} (${constraint.columns.join(", ")})`;
        if (constraint.type === "R" && constraint.references.length > 0) {
          description += ` references ${constraint.targetTable} (${constraint.references.join(", ")})`;
        }
        lines.push(description);
      }
    }
  }

  sendSchemaResult(state.requestId, lines.join("\n"));
}

function handleCompatibleSchemaResponse(key, state, message) {
  pendingCompatSchema.delete(key);
  if (message.error || message.result?.isError) {
    sendSchemaResult(state.requestId, resultText(message) || JSON.stringify(message.error ?? message.result), true);
    return;
  }

  const rows = parseCsv(resultText(message));
  const expectedHeaders = {
    tables: ["TABLE_NAME", "OBJECT_TYPE", "COMMENTS"],
    columns: ["TABLE_NAME", "COLUMN_NAME", "DATA_TYPE", "DATA_LENGTH", "DATA_PRECISION", "DATA_SCALE", "NULLABLE"],
    constraints: ["TABLE_NAME", "CONSTRAINT_NAME", "CONSTRAINT_TYPE", "COLUMN_NAME", "POSITION", "REFERENCED_TABLE", "REFERENCED_COLUMN"],
  }[state.stage];
  const header = rows[0]?.map((value) => value.trim().toUpperCase());
  if (!header || expectedHeaders.some((name, index) => header[index] !== name)) {
    sendSchemaResult(state.requestId,
      `Could not read Oracle schema metadata (${state.stage} query returned an unexpected format): ${resultText(message).slice(0, 500)}`,
      true);
    return;
  }

  const dataRows = rows.slice(1).filter((row) => row.length === expectedHeaders.length);
  if (state.stage === "tables") {
    state.tables = dataRows.map(([name, type, comment]) => ({ name, type, comment }));
    if (state.level === "OVERVIEW" || state.tables.length === 0) {
      completeCompatibleSchemaInfo(state);
      return;
    }

    const tablePredicate = `table_name IN (${state.tables.map((table) => sqlLiteral(table.name)).join(", ")})`;
    state.stage = "columns";
    sendSchemaQuery(state,
      `SELECT table_name, column_name, data_type, data_length, data_precision, data_scale, nullable\n` +
      `FROM all_tab_columns WHERE owner = ${sqlLiteral(state.schema)} AND ${tablePredicate}\n` +
      `ORDER BY table_name, column_id`);
    return;
  }

  if (state.stage === "columns") {
    state.columns = dataRows.map(([table, name, type, length, precision, scale, nullable]) => ({
      table, name, type, length, precision, scale, nullable,
    }));
    const tablePredicate = `c.table_name IN (${state.tables.map((table) => sqlLiteral(table.name)).join(", ")})`;
    state.stage = "constraints";
    sendSchemaQuery(state,
      `SELECT c.table_name, c.constraint_name, c.constraint_type, cc.column_name, cc.position,\n` +
      `       r.table_name AS referenced_table, rcc.column_name AS referenced_column\n` +
      `FROM all_constraints c\n` +
      `JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name AND cc.table_name = c.table_name\n` +
      `LEFT JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name\n` +
      `LEFT JOIN all_cons_columns rcc ON rcc.owner = r.owner AND rcc.constraint_name = r.constraint_name AND rcc.table_name = r.table_name AND rcc.position = cc.position\n` +
      `WHERE c.owner = ${sqlLiteral(state.schema)} AND c.constraint_type IN ('P', 'U', 'R') AND ${tablePredicate}\n` +
      `ORDER BY c.table_name, c.constraint_name, cc.position`);
    return;
  }

  state.constraints = dataRows.map(([table, name, type, column, _position, targetTable, referencedColumn]) => ({
    table, name, type, column, targetTable, referencedColumn,
  }));
  completeCompatibleSchemaInfo(state);
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
  const pendingCompatRequest = pendingCompatSchema.get(responseId);
  if (pendingCompatRequest) {
    handleCompatibleSchemaResponse(responseId, pendingCompatRequest, message);
    return;
  }

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
    if (message?.method === "tools/call" && message.params?.name === "schema_information" && startCompatibleSchemaInfo(message)) {
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
