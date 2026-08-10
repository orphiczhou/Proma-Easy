"use strict";
// Proma External MCP Server — stdio ↔ HTTP bridge
// 零外部依赖，手动实现 MCP JSON-RPC over stdio
// 自动扫描端口范围发现 Proma 实例，无需端口文件
// 用法：
//   node proma-mcp-server.cjs            → 默认找 Dev (PROMA_DEV=1)
//   node proma-mcp-server.cjs --release  → 找 Release
//   node proma-mcp-server.cjs --dev      → 显式找 Dev
//   node proma-mcp-server.cjs --host 192.168.1.100  → 直连 LAN 地址（跳过扫描）
// Claude Code 配置:
//   { "proma-dev-session": { "command": "node", "args": ["D:\\Proma-dev\\...\\proma-mcp-server.cjs", "--dev"] } }

const http = require("node:http");

const PORT_START = 19876;
const PORT_END = 19895;
const CONNECT_TIMEOUT = 2000;

// ---- 解析命令行参数 ----
const hostIdx = process.argv.indexOf("--host");
const TARGET_HOST = hostIdx >= 0 ? process.argv[hostIdx + 1] : null;
const targetMode = process.argv.includes("--release") ? "release" : "dev";

// ---- 端口扫描：获取实例信息 ----
function getInstanceInfo(port, host) {
  host = host || "127.0.0.1";
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: host, port, path: "/get_instance_info", method: "GET",
      timeout: CONNECT_TIMEOUT,
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch (_) { reject(new Error("bad json")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

async function discoverPort(host) {
  host = host || "127.0.0.1";
  const instances = [];
  for (let p = PORT_START; p <= PORT_END; p++) {
    try {
      const info = await getInstanceInfo(p, host);
      instances.push({ port: p, ...info });
    } catch (_) { /* port not available */ }
  }
  return instances;
}

// ---- HTTP 调用 ----
function callTool(port, name, args, host) {
  host = host || "127.0.0.1";
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(args || {});
    const req = http.request({
      hostname: host, port, path: "/" + name, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 600000,
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve({ error: "Invalid JSON response: " + data.slice(0, 200) }); }
      });
    });
    req.on("error", (e) => {
      reject(new Error(`Cannot reach Proma (${e.message}). Is it running?`));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out (10 min)")); });
    req.write(body);
    req.end();
  });
}

// ---- 工具定义 ----
const TOOLS = [
  { name: "get_my_session_id", description: "Get YOUR CURRENT session ID.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "list_channels", description: "List all configured AI channels and their available agent models.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "list_workspaces", description: "List all agent workspaces.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "list_sessions", description: "List all agent sessions with metadata.", inputSchema: { type: "object", properties: { include_archived: { type: "boolean" }, workspace_id: { type: "string" }, limit: { type: "number" } } } },
  { name: "get_session_info", description: "Get detailed information about a specific agent session.", inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] } },
  { name: "get_session_context", description: "Get the current context/token usage of an agent session.", inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] } },
  { name: "list_messages", description: "List messages for an agent session with pagination.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, limit: { type: "number" }, offset: { type: "number" } }, required: ["session_id"] } },
  { name: "create_session", description: "Create a NEW agent session with specified channel and model.", inputSchema: { type: "object", properties: { channel_id: { type: "string" }, model_id: { type: "string" }, title: { type: "string" }, workspace_id: { type: "string" } }, required: ["channel_id"] } },
  { name: "fork_session", description: "FORK an existing agent session, preserving conversation context.", inputSchema: { type: "object", properties: { source_session_id: { type: "string" }, up_to_message_uuid: { type: "string" }, title: { type: "string" }, new_channel_id: { type: "string" }, new_model_id: { type: "string" }, new_workspace_id: { type: "string" } }, required: ["source_session_id"] } },
  { name: "send_message", description: "Send a user message to an EXISTING agent session.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, message: { type: "string" }, wait: { type: "boolean" }, notify: { type: "boolean" }, model_id: { type: "string" }, channel_id: { type: "string" } }, required: ["session_id", "message"] } },
  { name: "archive_session", description: "Archive (or unarchive) an agent session. Archived sessions are hidden from default list.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, archived: { type: "boolean" } }, required: ["session_id"] } },
];

// ---- MCP JSON-RPC over stdio ----
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => { try { handle(JSON.parse(line)); } catch (_) {} });
rl.on("close", () => process.exit(0));

function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function sendError(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }

let PORT = null;
let serverInfo = { name: "proma-session", version: "1.0.0" };

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return;

  try {
    switch (method) {
      case "initialize":
        // 启动时扫描端口发现目标实例（或直连 --host）
        if (PORT === null) {
          const scanHost = TARGET_HOST || "127.0.0.1";
          const instances = await discoverPort(scanHost);
          const devs = instances.filter(i => i.proma_dev === true);
          const rels = instances.filter(i => i.proma_dev === false);

          if (TARGET_HOST) {
            // --host 模式：取第一个响应实例即可
            if (instances.length > 0) PORT = instances[0].port;
          } else if (targetMode === "dev" && devs.length > 0) PORT = devs[0].port;
          else if (targetMode === "release" && rels.length > 0) PORT = rels[0].port;
          else if (instances.length > 0) { PORT = instances[0].port; }

          if (PORT === null) {
            return sendError(id, -32603,
              `No Proma instance found at ${scanHost} (scanned ${PORT_START}-${PORT_END}, ` +
              `found ${instances.length} total). Is Proma running with PROMA_BRIDGE_HOST=0.0.0.0?`);
          }

          serverInfo = { name: `proma-${targetMode}-session`, version: "1.0.0" };
          process.stderr.write(`[proma-mcp-server] Connected to ${scanHost}:${PORT} (${instances[0].instance || targetMode})\n`);
        }
        return send(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo,
        });

      case "tools/list":
        return send(id, { tools: TOOLS });

      case "tools/call": {
        const result = await callTool(PORT, params.name, params.arguments || {}, TARGET_HOST);
        return send(id, result);
      }

      default:
        return sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return sendError(id, -32603, e instanceof Error ? e.message : String(e));
  }
}
