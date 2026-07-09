#!/usr/bin/env node
/*
 * Claudão² Bridge — instalador de um comando.
 * Registra o MCP "claudao2" na lista de servidores MCP de:
 *   - Claude Code   (~/.claude.json)
 *   - Cursor        (~/.cursor/mcp.json)
 *   - VS Code       (<config>/Code/User/mcp.json)
 *   - Windsurf      (~/.codeium/windsurf/mcp_config.json)
 * Idempotente: mescla sem apagar outros servidores. Rode uma vez:
 *   node "<caminho>/bridge/install.mjs"
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "mcp-server.mjs").replace(/\\/g, "/");
const HOME = os.homedir();
const NAME = "claudao2";

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function vscodeUserDir() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(HOME, "AppData/Roaming"), "Code", "User");
  if (process.platform === "darwin") return path.join(HOME, "Library", "Application Support", "Code", "User");
  return path.join(HOME, ".config", "Code", "User");
}

// Cada alvo: caminho do config, a chave ("mcpServers"|"servers") e o shape da entrada.
const targets = [
  { name: "Claude Code", file: path.join(HOME, ".claude.json"), key: "mcpServers", entry: { command: "node", args: [SERVER] } },
  { name: "Cursor", file: path.join(HOME, ".cursor", "mcp.json"), key: "mcpServers", entry: { command: "node", args: [SERVER] } },
  { name: "Windsurf", file: path.join(HOME, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers", entry: { command: "node", args: [SERVER] } },
  { name: "VS Code", file: path.join(vscodeUserDir(), "mcp.json"), key: "servers", entry: { type: "stdio", command: "node", args: [SERVER] } },
];

let done = 0;
for (const t of targets) {
  try {
    const cfg = readJson(t.file);
    if (!cfg[t.key] || typeof cfg[t.key] !== "object") cfg[t.key] = {};
    cfg[t.key][NAME] = t.entry;
    writeJson(t.file, cfg);
    console.log(`  ✓ ${t.name.padEnd(12)} → ${t.file}`);
    done++;
  } catch (e) {
    console.log(`  ✗ ${t.name.padEnd(12)} (${e.message})`);
  }
}
console.log(`\nRegistrado em ${done}/${targets.length} editores. Reinicie o editor (ou recarregue os MCP servers) e o "claudao2" aparece na lista.`);
console.log(`Servidor: node "${SERVER}"`);
