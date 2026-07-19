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
import { execSync } from "node:child_process";

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

// Descobre (SEM matar) processos que seguram a porta do hub e cuja linha de comando é um
// mcp-server.mjs de OUTRA pasta. Migração entre pastas deixa o bridge antigo vivo segurando a
// 8765 → o desta pasta vira só "client" e nunca vira hub (nunca manda server_hello) → a extensão
// fica presa no caminho antigo. Aqui só AVISAMOS com o PID e o comando exato pra matar.
function staleBridgesOnPort(port) {
  const found = [];
  try {
    if (process.platform === "win32") {
      // OutputEncoding=UTF8: sem isso o PowerShell 5.1 emite a CommandLine no codepage do console
      // (cp850/1252) e o "ã" de "Extensão" vira "�" no decode utf8 → a comparação falha e o bridge
      // da PRÓPRIA pasta é reportado como "de outra pasta" (falso positivo).
      const ps = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"
        + "$c = Get-NetTCPConnection -LocalPort " + port + " -State Listen -ErrorAction SilentlyContinue;"
        + " foreach ($x in $c) { $p = Get-CimInstance Win32_Process -Filter (\\\"ProcessId=\\\" + $x.OwningProcess) -ErrorAction SilentlyContinue;"
        + " if ($p) { Write-Output ($x.OwningProcess.ToString() + '|' + $p.CommandLine) } }";
      const out = execSync("powershell -NoProfile -Command \"" + ps + "\"", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const norm = (s) => s.replace(/\\/g, "/").normalize("NFC").toLowerCase();
      const server = norm(SERVER);
      for (const line of out.split(/\r?\n/)) {
        const i = line.indexOf("|"); if (i < 0) continue;
        const pid = line.slice(0, i).trim(); const cmd = line.slice(i + 1);
        if (/mcp-server\.mjs/i.test(cmd) && !norm(cmd).includes(server)) found.push({ pid, cmd: cmd.trim(), kill: "Stop-Process -Id " + pid + " -Force" });
      }
    } else {
      const out = execSync("lsof -nP -iTCP:" + port + " -sTCP:LISTEN -t 2>/dev/null || true", { encoding: "utf8" });
      for (const pid of out.split(/\s+/).filter(Boolean)) {
        let cmd = ""; try { cmd = execSync("ps -o command= -p " + pid, { encoding: "utf8" }).trim(); } catch { /* ignore */ }
        if (/mcp-server\.mjs/i.test(cmd) && !cmd.includes(SERVER)) found.push({ pid, cmd, kill: "kill " + pid });
      }
    }
  } catch { /* best-effort: sem netstat/lsof, só seguimos */ }
  return found;
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
    // Claude Code: overrides por-projeto (projects.*.mcpServers.claudao2) NÃO herdam o topo. Se
    // algum aponta pra outra pasta (ex.: uma cópia antiga da extensão), o Claude Code daquele
    // projeto ressuscita o server velho. Repontar TODO override do claudao2 p/ este server.
    if (t.name === "Claude Code" && cfg.projects && typeof cfg.projects === "object") {
      for (const proj of Object.values(cfg.projects)) {
        if (proj && proj.mcpServers && proj.mcpServers[NAME]) proj.mcpServers[NAME] = t.entry;
      }
    }
    writeJson(t.file, cfg);
    console.log(`  ✓ ${t.name.padEnd(12)} → ${t.file}`);
    done++;
  } catch (e) {
    console.log(`  ✗ ${t.name.padEnd(12)} (${e.message})`);
  }
}
console.log(`\nRegistrado em ${done}/${targets.length} editores. Reinicie o editor (ou recarregue os MCP servers) e o "claudao2" aparece na lista.`);
console.log(`Servidor: node "${SERVER}"`);

// Migração entre pastas: avisa se um bridge de OUTRA pasta ainda segura a porta do hub.
const stale = staleBridgesOnPort(Number(process.env.CLAUDAO_BRIDGE_PORT || 8765));
if (stale.length) {
  console.log(`\n⚠ Há um bridge de OUTRA pasta ainda rodando e segurando a porta do hub (8765).`);
  console.log(`  Enquanto ele viver, ESTE server só vira "client" e a extensão continua mostrando o caminho ANTIGO.`);
  for (const s of stale) console.log(`   PID ${s.pid}: ${s.cmd}\n     → encerre com:  ${s.kill}`);
  console.log(`  Depois, reinicie o editor (recarrega os MCP) e recarregue a extensão em chrome://extensions.`);
}
