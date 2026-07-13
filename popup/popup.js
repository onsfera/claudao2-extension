/*
 * Claudão² — popup da extensão.
 * Status da integração com o Claude externo + comando de registro do MCP (copiável) +
 * atalho pro painel lateral (o clique no ícone passou a abrir este popup; Ctrl+E segue abrindo o painel).
 */
const STATUS_KEY = "cm_bridge_status";
const ENABLED_KEY = "cm_bridge_enabled";
const PATHS_KEY = "cm_bridge_paths";
// Placeholder distribuível (o Chrome não sabe o próprio path no disco). Ao conectar, o server
// informa o caminho REAL desta máquina (server_hello → cm_bridge_paths) e fica gravado.
const FALLBACK_INSTALL = "<pasta-da-extensão>/bridge/install.mjs";
let cmdText = "";

async function refreshStatus() {
  let g = {};
  try { g = await chrome.storage.local.get([STATUS_KEY, ENABLED_KEY, PATHS_KEY]); } catch (_) {}
  const on = !!(g[ENABLED_KEY] && g[ENABLED_KEY].on);
  const up = !!(g[STATUS_KEY] && g[STATUS_KEY].hubConnected && Date.now() - (g[STATUS_KEY].ts || 0) < 60000);
  const dot = document.getElementById("dot"), txt = document.getElementById("status-text");
  if (!on) { dot.className = "dot off"; txt.textContent = "Integração desativada"; }
  else if (up) { dot.className = "dot on"; txt.textContent = "Conectado ao Claude externo"; }
  else { dot.className = "dot wait"; txt.textContent = "Ligada — aguardando o Claude do VS Code"; }
  const install = (g[PATHS_KEY] && g[PATHS_KEY].install) || FALLBACK_INSTALL;
  cmdText = 'node "' + install + '"';
  document.getElementById("cmd").textContent = cmdText;
}

document.getElementById("copy").addEventListener("click", async () => {
  const btn = document.getElementById("copy");
  let ok = false;
  try { await navigator.clipboard.writeText(cmdText); ok = true; }
  catch (_) { try { const ta = document.createElement("textarea"); ta.value = cmdText; document.body.appendChild(ta); ta.select(); ok = document.execCommand("copy"); ta.remove(); } catch (_) {} }
  btn.textContent = ok ? "✓ Copiado" : "Copie manualmente";
  setTimeout(() => { btn.textContent = "⧉ Copiar comando"; }, 1500);
});

document.getElementById("open").addEventListener("click", async () => {
  try {
    const w = await chrome.windows.getCurrent();
    if (chrome.sidePanel && chrome.sidePanel.open) await chrome.sidePanel.open({ windowId: w.id });
  } catch (_) {}
  window.close();
});

// Reflete mudanças ao vivo (conexão cai/sobe, server_hello atualiza o caminho).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STATUS_KEY] || changes[ENABLED_KEY] || changes[PATHS_KEY]) refreshStatus();
});
refreshStatus();
