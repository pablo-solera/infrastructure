const endpoint = process.env.MCP_URL ?? "http://127.0.0.1:9001/mcp";
const protocolVersion = "2024-11-05";
let sessionId;
let nextId = 0;

async function request(message) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  const newSessionId = response.headers.get("mcp-session-id");
  if (newSessionId) sessionId = newSessionId;
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text}`);

  const data = text.match(/^data: (.+)$/m)?.[1];
  return data ? JSON.parse(data) : undefined;
}

async function callTool(name, args = {}) {
  const result = await request({
    jsonrpc: "2.0",
    id: ++nextId,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (result?.error) throw new Error(`${name}: ${result.error.message}`);
  if (result?.result?.isError) {
    throw new Error(`${name}: ${JSON.stringify(result.result.content)}`);
  }
  return result?.result;
}

const initialized = await request({
  jsonrpc: "2.0",
  id: ++nextId,
  method: "initialize",
  params: {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "timertask-smoke-test", version: "1.0.0" },
  },
});
if (initialized?.error) throw new Error(initialized.error.message);
if (!sessionId) throw new Error("Initialize response did not include MCP-Session-Id");

await request({ jsonrpc: "2.0", method: "notifications/initialized" });
const listed = await request({ jsonrpc: "2.0", id: ++nextId, method: "tools/list" });
const toolNames = listed?.result?.tools?.map((tool) => tool.name) ?? [];
const requiredTools = [
  "connections_list",
  "connect",
  "disconnect",
  "sql_run",
  "schema_information",
  "request_status",
];
for (const name of requiredTools) {
  if (!toolNames.includes(name)) throw new Error(`Expected MCP tool is missing: ${name}`);
}
for (const name of ["sqlcl_run", "skills_sync", "annotation_generate"]) {
  if (toolNames.includes(name)) throw new Error(`Blocked MCP tool is visible: ${name}`);
}

const blockedTool = await request({
  jsonrpc: "2.0",
  id: ++nextId,
  method: "tools/call",
  params: { name: "sqlcl_run", arguments: { sqlcl: "help" } },
});
if (blockedTool?.error?.code !== -32601) {
  throw new Error("Direct call to blocked sqlcl_run was not rejected");
}

const blockedConnection = await request({
  jsonrpc: "2.0",
  id: ++nextId,
  method: "tools/call",
  params: { name: "connect", arguments: { connection_name: "other" } },
});
if (blockedConnection?.error?.code !== -32602) {
  throw new Error("A connection other than 'timertask' was not rejected");
}

const connections = await callTool("connections_list");
if (!JSON.stringify(connections).toLowerCase().includes("timertask")) {
  throw new Error("Saved connection 'timertask' was not listed");
}
await callTool("connect", { connection_name: "timertask" });

const currentSchema = await callTool("sql_run", {
  sql: "select sys_context('userenv', 'current_schema') as current_schema from dual",
});
if (!JSON.stringify(currentSchema).includes("TIMERTASK_ES")) {
  throw new Error(`Expected CURRENT_SCHEMA=TIMERTASK_ES, got: ${JSON.stringify(currentSchema)}`);
}

const oracleVersion = await callTool("sql_run", {
  sql: "select banner from v$version where rownum = 1",
});

console.log(JSON.stringify({
  endpoint,
  server: initialized.result.serverInfo,
  tools: toolNames,
  currentSchema: "TIMERTASK_ES",
  oracleVersion: oracleVersion.content,
}, null, 2));

await fetch(endpoint, {
  method: "DELETE",
  headers: { "mcp-session-id": sessionId },
}).catch(() => {});
