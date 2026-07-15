/*
 * Claudão² — popup da extensão.
 * Status da integração com o Claude externo + comando de registro do MCP (copiável) +
 * atalho pro painel lateral (o clique no ícone passou a abrir este popup; Ctrl+E segue abrindo o painel).
 */
const STATUS_KEY = "cm_bridge_status";
const ENABLED_KEY = "cm_bridge_enabled";
const PATHS_KEY = "cm_bridge_paths";
// Fallback = caminho REAL desta instalação (o Chrome não sabe o próprio path no disco; noutra
// máquina o server_hello sobrescreve com o caminho local ao conectar — cm_bridge_paths).
const FALLBACK_INSTALL = "C:/Users/ferna/Desktop/Extensão Claude/extensao-mod/bridge/install.mjs";
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

// Aba ativa PRÉ-carregada no load do popup: o sidePanel.open precisa rodar com o gesto do usuário
// vivo — um await dentro do click (tabs.query/windows.getCurrent) pode invalidar o gesto.
let cmActiveTab = null;
try { chrome.tabs.query({ active: true, currentWindow: true }, (ts) => { cmActiveTab = (ts && ts[0]) || null; }); } catch (_) {}

document.getElementById("open").addEventListener("click", () => {
  // Réplica do fluxo do bundle original (action.onClicked de antes do popup): o painel é POR ABA,
  // com o tabId na URL — open({windowId}) sozinho falha porque nenhum path foi setado (não há
  // side_panel.default_path no manifest; o bundle seta por aba).
  try {
    if (cmActiveTab && cmActiveTab.id != null) {
      chrome.sidePanel.setOptions({ tabId: cmActiveTab.id, path: "sidepanel.html?tabId=" + encodeURIComponent(cmActiveTab.id), enabled: true });
      const p = chrome.sidePanel.open({ tabId: cmActiveTab.id }); if (p && p.catch) p.catch(() => {});
    } else if (cmActiveTab && cmActiveTab.windowId != null) {
      const p = chrome.sidePanel.open({ windowId: cmActiveTab.windowId }); if (p && p.catch) p.catch(() => {});
    }
  } catch (_) {}
  setTimeout(() => window.close(), 150); // fecha depois do open despachar (fechar já pode abortar o gesto)
});

// Reflete mudanças ao vivo (conexão cai/sobe, server_hello atualiza o caminho).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STATUS_KEY] || changes[ENABLED_KEY] || changes[PATHS_KEY]) refreshStatus();
});
refreshStatus();
