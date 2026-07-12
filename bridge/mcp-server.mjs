#!/usr/bin/env node
/*
 * Claudão² Bridge — MCP server (stdio) + WebSocket hub. ZERO dependências.
 * ----------------------------------------------------------------------
 *   Claude externo (VS Code, etc.)  --stdio/JSON-RPC-->  ESTE server
 *                                    --WebSocket-->  Claudão² (service worker)
 *
 * Sem npm install: o WebSocket é implementado na mão (RFC 6455). Basta:
 *   claude mcp add claudao2 -- node "<caminho>/bridge/mcp-server.mjs"
 *
 * Ferramentas: browser_tabs, browser_read, browser_console, browser_eval,
 * browser_screenshot, browser_click, browser_fill, browser_navigate.
 * Todas funcionam em abas em BACKGROUND (via tabId), sem roubar o foco.
 *
 * IMPORTANTE: stdout é só JSON-RPC do MCP. Diagnóstico vai para stderr.
 */
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(HERE, "mcp-server.mjs");
const INSTALL_PATH = path.join(HERE, "install.mjs");

const PORT = Number(process.env.CLAUDAO_BRIDGE_PORT || 8765);
const log = (...a) => process.stderr.write("[claudao2-bridge] " + a.join(" ") + "\n");

let clientName = "Claude externo"; // preenchido no initialize (clientInfo.name)

// ---------------------------------------------------------------------------
// Transporte: UM ÚNICO HUB (WebSocket em 127.0.0.1:PORT) para a extensão, e
// VÁRIOS EDITORES (VS Code/Cursor/...) compartilhando esse hub. O 1º mcp-server
// a subir vira o HUB (dono da porta + fala com a extensão); os demais viram
// CLIENTES do hub e encaminham seus comandos por ele. Se o hub cair, um cliente
// assume a porta sozinho (auto-eleição). WebSocket implementado à mão (RFC 6455).
// ---------------------------------------------------------------------------
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
let role = null;                 // 'hub' | 'client' | null (elegendo)
let extConn = null;              // (hub) conexão da extensão do Chrome
let upstream = null;             // (client) conexão com o hub
let httpServer = null;
let seq = 0, crid = 0;
const pending = new Map();       // (hub) id -> {editorConn, rid, timer, resolve}
const clientPending = new Map(); // (client) rid -> {resolve, timer}

// makeConn: conexão WebSocket sobre um socket já aberto. opts.mask=true quando
// ESTE lado é cliente (frames client->server precisam ser mascarados).
function makeConn(socket, opts = {}) {
  const mask = !!opts.mask;
  let buffer = opts.initial && opts.initial.length ? Buffer.from(opts.initial) : Buffer.alloc(0);
  let frags = [], fragOp = 0;
  const conn = { open: true, onMessage: null, onClose: null };

  function sendFrame(opcode, payload) {
    const len = payload.length; let header; const mb = mask ? 0x80 : 0;
    if (len < 126) header = Buffer.from([0x80 | opcode, mb | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = mb | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = mb | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    try {
      if (mask) { const key = crypto.randomBytes(4); const out = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3]; socket.write(Buffer.concat([header, key, out])); }
      else socket.write(Buffer.concat([header, payload]));
    } catch (_) {}
  }
  conn.send = (text) => sendFrame(0x1, Buffer.from(text, "utf8"));
  conn.close = () => { conn.open = false; try { sendFrame(0x8, Buffer.alloc(0)); socket.end(); } catch (_) {} };

  function handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) { conn.open = false; try { socket.end(); } catch (_) {} return; }
    if (opcode === 0x9) { sendFrame(0xa, payload); return; } // ping -> pong
    if (opcode === 0xa) return; // pong
    if (opcode === 0x0) frags.push(payload); else { frags = [payload]; fragOp = opcode; }
    if (fin) { const full = Buffer.concat(frags); frags = []; if (fragOp === 0x1 && conn.onMessage) conn.onMessage(full.toString("utf8")); }
  }
  function parse() {
    while (true) {
      if (buffer.length < 2) return;
      const b0 = buffer[0], b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (buffer.length < off + 2) return; len = buffer.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (buffer.length < off + 8) return; len = Number(buffer.readBigUInt64BE(off)); off += 8; }
      let mk; if (masked) { if (buffer.length < off + 4) return; mk = buffer.subarray(off, off + 4); off += 4; }
      if (buffer.length < off + len) return;
      let payload = buffer.subarray(off, off + len); buffer = buffer.subarray(off + len);
      if (masked) { const out = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mk[i & 3]; payload = out; }
      handleFrame(fin, opcode, payload);
    }
  }
  socket.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); try { parse(); } catch (e) { log("parse erro:", e.message); } });
  socket.on("close", () => { conn.open = false; if (conn.onClose) conn.onClose(); });
  socket.on("error", () => { conn.open = false; });
  if (buffer.length) { try { parse(); } catch (_) {} }
  return conn;
}

// --- HUB: encaminha comandos (próprios e dos editores clientes) à extensão ---
function forwardToExtension(cmd, args, client, editorConn, rid, resolve) {
  if (!extConn || !extConn.open) {
    const err = { ok: false, error: "A extensão Claudão² não está conectada ao hub. Abra o Chrome com a extensão e ligue a integração (botão 🧠 → tomada)." };
    if (editorConn) { try { editorConn.send(JSON.stringify({ rid, ...err })); } catch (_) {} } else if (resolve) resolve(err);
    return;
  }
  const id = ++seq;
  const timer = setTimeout(() => {
    pending.delete(id);
    const err = { ok: false, error: "Tempo esgotado no comando '" + cmd + "'." };
    if (editorConn) { try { editorConn.send(JSON.stringify({ rid, ...err })); } catch (_) {} } else if (resolve) resolve(err);
  }, 25000);
  pending.set(id, { editorConn, rid, timer, resolve });
  extConn.send(JSON.stringify({ id, cmd, args: args || {}, client: client || "Claude externo" }));
}
function dispatchHub(cmd, args, client) { return new Promise((resolve) => forwardToExtension(cmd, args, client, null, null, resolve)); }

function onUpgrade(req, socket) {
  const origin = req.headers.origin || "";
  const isEditor = String(req.headers["x-claudao-role"] || "").toLowerCase() === "editor";
  if (!isEditor && !origin.startsWith("chrome-extension://")) { log("upgrade rejeitado (origin):", origin || "(vazio)"); socket.destroy(); return; }
  const key = req.headers["sec-websocket-key"]; if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  const conn = makeConn(socket, { mask: false });
  if (isEditor) {
    log("editor conectado ao hub");
    conn.onMessage = (data) => { let m; try { m = JSON.parse(data); } catch { return; } if (m.type === "hello") return; if (m.cmd) forwardToExtension(m.cmd, m.args, m.client, conn, m.rid, null); };
    conn.onClose = () => { for (const [id, p] of pending) if (p.editorConn === conn) { clearTimeout(p.timer); pending.delete(id); } };
  } else {
    extConn = conn;
    log("extensão conectada:", origin);
    // Auto-descoberta de caminho: o hub informa onde ELE está no disco (o Chrome não sabe o próprio path).
    try { conn.send(JSON.stringify({ type: "server_hello", installPath: INSTALL_PATH, serverPath: SERVER_PATH })); } catch (_) {}
    // Keepalive: mensagem periódica mantém o service worker do Chrome acordado
    // enquanto o hub está de pé (evita o SW dormir e o VS Code "não achar" a extensão).
    const ka = setInterval(() => { try { if (extConn === conn && conn.open) conn.send(JSON.stringify({ type: "keepalive" })); } catch (_) {} }, 20000);
    conn.onMessage = (data) => {
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.type === "hello") { log("hello:", JSON.stringify(m.info || {})); return; }
      const p = pending.get(m.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(m.id);
      if (p.editorConn) { try { p.editorConn.send(JSON.stringify({ rid: p.rid, ok: m.ok, result: m.result, error: m.error })); } catch (_) {} }
      else if (p.resolve) p.resolve(m);
    };
    conn.onClose = () => { clearInterval(ka); if (extConn === conn) extConn = null; log("extensão desconectou"); };
  }
}

// --- CLIENT: conecta no hub existente e encaminha os próprios comandos ---
function wsConnect(port, host, headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => {
      const key = crypto.randomBytes(16).toString("base64");
      let req = "GET / HTTP/1.1\r\nHost: " + host + ":" + port + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n";
      for (const h in headers) req += h + ": " + headers[h] + "\r\n";
      req += "\r\n"; socket.write(req);
    });
    let buf = Buffer.alloc(0), done = false;
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n"); if (idx < 0) return;
      if (!/ 101 /.test(buf.slice(0, idx).toString())) { socket.destroy(); if (!done) { done = true; reject(new Error("handshake do hub falhou")); } return; }
      const rest = buf.slice(idx + 4);
      socket.removeListener("data", onData);
      const conn = makeConn(socket, { mask: true, initial: rest });
      done = true; resolve(conn);
    };
    socket.on("data", onData);
    socket.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}
async function connectClient() {
  try { upstream = await wsConnect(PORT, "127.0.0.1", { "X-Claudao-Role": "editor" }); }
  catch (e) { upstream = null; role = null; setTimeout(ensureRole, 600); return; }
  log("conectado ao hub como editor");
  try { upstream.send(JSON.stringify({ type: "hello", info: { editor: clientName } })); } catch (_) {}
  upstream.onMessage = (data) => { let m; try { m = JSON.parse(data); } catch { return; } const p = clientPending.get(m.rid); if (p) { clearTimeout(p.timer); clientPending.delete(m.rid); p.resolve(m); } };
  upstream.onClose = () => { upstream = null; role = null; log("hub caiu — reelegendo"); ensureRole(); };
}
function dispatchClient(cmd, args, client) {
  return new Promise((resolve) => {
    if (!upstream || !upstream.open) return resolve({ ok: false, error: "hub indisponível (reconectando)" });
    const rid = ++crid;
    const timer = setTimeout(() => { clientPending.delete(rid); resolve({ ok: false, error: "Tempo esgotado no comando '" + cmd + "'." }); }, 25000);
    clientPending.set(rid, { resolve, timer });
    try { upstream.send(JSON.stringify({ rid, cmd, args: args || {}, client: client || clientName })); }
    catch (e) { clearTimeout(timer); clientPending.delete(rid); resolve({ ok: false, error: String((e && e.message) || e) }); }
  });
}

// --- Eleição: tenta virar hub; se a porta estiver ocupada, vira cliente ---
function ensureRole() {
  if (role) return;
  const srv = http.createServer((req, res) => { res.writeHead(426); res.end("Upgrade Required"); });
  srv.on("upgrade", onUpgrade);
  srv.on("error", (e) => {
    try { srv.close(); } catch (_) {}
    if (e && e.code === "EADDRINUSE") { role = "client"; httpServer = null; connectClient(); }
    else { log("hub erro:", e && e.message); role = null; setTimeout(ensureRole, 800); }
  });
  srv.listen(PORT, "127.0.0.1", () => { role = "hub"; httpServer = srv; log("HUB ativo em ws://127.0.0.1:" + PORT); });
}

// Despacho de comando para a extensão, seja qual for o papel deste processo.
function dispatch(cmd, args) {
  if (role === "hub") return dispatchHub(cmd, args, clientName);
  if (role === "client") return dispatchClient(cmd, args, clientName);
  return Promise.resolve({ ok: false, error: "conectando ao hub — tente o comando de novo em instantes" });
}

ensureRole();

// ---------------------------------------------------------------------------
// Ferramentas MCP
// ---------------------------------------------------------------------------
const TABID = { type: "number", description: "tabId da aba alvo (use browser_tabs para listar). Funciona mesmo em aba de fundo. Omita para a aba ativa." };
const TOOLS = [
  { name: "browser_tabs", cmd: "tabs", description: "Lista as abas http/https abertas (tabId, url, título, ativa). Use para escolher em qual página agir, inclusive abas em segundo plano.", inputSchema: { type: "object", properties: {} } },
  // --- Percepção ---
  { name: "browser_read", cmd: "read", description: "Lê a página: 'text' (visível), 'html', 'markdown' ou 'a11y' (elementos interativos/acessibilidade). Funciona em abas de fundo.", inputSchema: { type: "object", properties: { tabId: TABID, format: { type: "string", enum: ["text", "html", "markdown", "a11y"] }, maxChars: { type: "number" } } } },
  { name: "browser_query", cmd: "query", description: "Consulta estruturada: para cada elemento que casa o seletor CSS, retorna texto/valor/atributos/posição/visibilidade.", inputSchema: { type: "object", properties: { tabId: TABID, selector: { type: "string" }, limit: { type: "number" } }, required: ["selector"] } },
  { name: "browser_snapshot", cmd: "snapshot", description: "Mapa dos elementos interativos visíveis (links, botões, campos) com um 'ref' estável, papel, rótulo e posição. Use o ref em click/fill/hover para robustez (evita seletores frágeis).", inputSchema: { type: "object", properties: { tabId: TABID } } },
  { name: "browser_get_state", cmd: "get_state", description: "Estado da página: url, título, readyState, viewport, e sinais úteis 'modalOpen' (há um modal/diálogo aberto?) e 'spinner' (está carregando?). Opcional: cookies e chaves de localStorage (redigidos).", inputSchema: { type: "object", properties: { tabId: TABID, includeStorage: { type: "boolean" } } } },
  { name: "browser_console", cmd: "console", description: "Logs/erros de console capturados desde o carregamento. Filtre por nível.", inputSchema: { type: "object", properties: { tabId: TABID, limit: { type: "number" }, level: { type: "string", enum: ["log", "info", "warn", "error", "debug"] } } } },
  { name: "browser_network", cmd: "network", description: "Requisições de rede recentes da aba (método, url, status, tipo, duração). Capturado por fetch/XHR na página.", inputSchema: { type: "object", properties: { tabId: TABID, limit: { type: "number" }, filter: { type: "string", description: "substring da url para filtrar" } } } },
  { name: "browser_eval", cmd: "eval", description: "Executa JavaScript na página (via chrome.debugger) e retorna o resultado. Aceita await. Funciona em abas de fundo.", inputSchema: { type: "object", properties: { tabId: TABID, code: { type: "string" } }, required: ["code"] } },
  { name: "browser_screenshot", cmd: "screenshot", description: "Foto da página (viewport), de um elemento (selector) ou inteira (fullPage). Barata por padrão: JPEG reduzido (~1280px de largura); ajuste maxWidth/format/quality. Via CDP, funciona em segundo plano. DICA de custo: para DADOS use browser_read/browser_eval/browser_query; use a foto para VALIDAÇÃO VISUAL (aparência, cor, layout). Para ver E agir no mesmo quadro, prefira browser_look.", inputSchema: { type: "object", properties: { tabId: TABID, selector: { type: "string" }, fullPage: { type: "boolean" }, maxWidth: { type: "number", description: "largura máx. em px (padrão 1280; reduz custo)" }, format: { type: "string", enum: ["jpeg", "png"], description: "padrão jpeg (mais leve)" }, quality: { type: "number", description: "qualidade JPEG 20-95 (padrão 72)" }, redactPII: { type: "boolean", description: "borra campos sensíveis (senha/email/telefone/cartão/CPF) na foto (viewport). Também pode ser ligado sempre em Segurança." } } } },
  { name: "browser_look", cmd: "look", description: "OLHA a tela para ver E agir no mesmo quadro: screenshot LEVE com os elementos interativos NUMERADOS (set-of-marks) + o mapa número→ref/papel/rótulo. Clique/preencha por 'ref' (ex.: browser_click {ref:'r12'}), sem seletor frágil. Os números aparecem na foto (o modelo vê) e na tela (o usuário vê). Retorna também modalOpen/spinner. É o jeito recomendado de perceber a página quando você vai interagir com ela.", inputSchema: { type: "object", properties: { tabId: TABID, limit: { type: "number", description: "máx. de elementos marcados (padrão 100)" }, maxWidth: { type: "number" }, quality: { type: "number" }, keepMarks: { type: "boolean", description: "mantém os números na tela alguns segundos" }, redactPII: { type: "boolean", description: "borra campos sensíveis na foto" } } } },
  { name: "browser_inspect", cmd: "inspect", description: "Inspeciona UM elemento (por selector, ref ou text): estilos computados, box model, atributos, a11y e um trecho de HTML — como o inspetor do DevTools. Destaca o elemento na tela por um instante.", inputSchema: { type: "object", properties: { tabId: TABID, selector: { type: "string" }, ref: { type: "string" }, text: { type: "string" } } } },
  { name: "browser_observe", cmd: "observe", description: "O que MUDOU no DOM desde a última observação (adições/remoções/atributos/texto), já filtrando o ruído da própria extensão. Comece com reset:true para (re)iniciar; depois chame sem reset para pegar só o delta (as mais NOVAS; 'dropped' indica quantas foram além do limit). Use stop:true para desligar o observador. Ideal para loops de ajuste sem re-fotografar a página.", inputSchema: { type: "object", properties: { tabId: TABID, reset: { type: "boolean", description: "(re)inicia a observação" }, stop: { type: "boolean", description: "desliga o observador" }, limit: { type: "number" } } } },
  { name: "browser_wait", cmd: "wait", description: "Espera uma condição antes de continuar: elemento visível/oculto (selector+state), a url conter algo (urlContains), ou tempo (timeoutMs). Essencial em SPAs.", inputSchema: { type: "object", properties: { tabId: TABID, selector: { type: "string" }, state: { type: "string", enum: ["visible", "hidden"] }, urlContains: { type: "string" }, timeoutMs: { type: "number" } } } },
  // --- Ação ---
  { name: "browser_click", cmd: "click", description: "Clica no elemento: por 'selector' CSS, 'ref' (de browser_snapshot) ou 'text'. Rola até ele, espera visível, espera spinner sumir, e move o cursor animado. Retorna 'changed'/'navigated' (o clique teve efeito?) e 'errors' (validação). IMPORTANTE: para botões de 'carregar/enviar/anexar arquivo', NÃO clique (abriria o seletor de arquivos do sistema, que TRAVA o agente) — use browser_upload direto com o caminho do arquivo. Se um clique tentar abrir o seletor, ele é bloqueado e o retorno traz filePickerBlocked=true. Use real=true para eventos de mouse REAIS via CDP. Em SPA que fica carregando de propósito, use nowait=true (clica e retorna sem esperar a página assentar, evitando timeout). timeoutMs ajusta a espera do elemento ficar visível.", inputSchema: { type: "object", properties: { tabId: TABID, selector: { type: "string" }, ref: { type: "string" }, text: { type: "string" }, real: { type: "boolean", description: "clique com eventos reais de mouse (CDP Input)" }, nowait: { type: "boolean", description: "fire-and-forget: não espera spinner nem confere efeito (evita timeout em páginas que carregam de propósito)" }, timeoutMs: { type: "number", description: "espera máx. pelo elemento ficar visível (padrão 6000)" } } } },
  { name: "browser_fill", cmd: "fill", description: "Preenche input/textarea (por selector ou ref). Dispara input/change. Retorna 'verified' (o valor realmente entrou no campo?) e 'errors' (validação). clearFirst limpa antes.", inputSchema: { type: "object", properties: { tabId: TABID, selector: { type: "string" }, ref: { type: "string" }, value: { type: "string" }, clearFirst: { type: "boolean" } }, required: ["value"] } },
  { name: "browser_type", cmd: "type", description: "Digita texto tecla a tecla no elemento (selector) ou no elemento focado.", inputSchema: { type: "object", properties: { tabId: TABID, selector: { type: "string" }, text: { type: "string" } }, required: ["text"] } },
  { name: "browser_press", cmd: "press", description: "Pressiona uma tecla no elemento focado: Enter, Tab, Escape, ArrowDown, etc.", inputSchema: { type: "object", properties: { tabId: TABID, key: { type: "string" } }, required: ["key"] } },
  { name: "browser_hover", cmd: "hover", description: "Passa o cursor sobre o elemento (abre menus/tooltips). Cursor animado.", inputSchema: { type: "object", properties: { tabId: TABID, selector: { type: "string" }, ref: { type: "string" } } } },
  { name: "browser_scroll", cmd: "scroll", description: "Rola a página: até um elemento (selector), por uma quantidade (deltaY) ou para 'top'/'bottom'.", inputSchema: { type: "object", properties: { tabId: TABID, selector: { type: "string" }, deltaY: { type: "number" }, to: { type: "string", enum: ["top", "bottom"] } } } },
  { name: "browser_select", cmd: "select", description: "Escolhe uma opção num dropdown por 'label' (texto) ou 'value'. Funciona tanto no <select> NATIVO quanto em comboboxes CUSTOMIZADOS (mat-select/cfc-select do Google, [role=combobox]): abre o overlay e clica a opção ATOMICAMENTE num comando só (evita o problema do overlay fechar entre chamadas). Aponte o 'selector'/'ref' para o combobox e passe 'label' com o texto da opção.", inputSchema: { type: "object", properties: { tabId: TABID, selector: { type: "string" }, ref: { type: "string" }, value: { type: "string" }, label: { type: "string" } } } },
  { name: "browser_submit", cmd: "submit", description: "Submete um formulário (selector do form ou de um campo dentro dele). Retorna 'navigated' e 'errors' (mensagens de validação que apareceram após o envio) — use para saber se o envio foi aceito ou barrado.", inputSchema: { type: "object", properties: { tabId: TABID, selector: { type: "string" } } } },
  { name: "browser_navigate", cmd: "navigate", description: "Navega a ABA ATUAL para uma URL — isso SUBSTITUI a página (você perde formulários/estado dela). Para abrir uma página de referência, recurso ou arquivo SEM perder a página em que está trabalhando, passe newTab:true (ou use browser_open_tab) e continue agindo na aba original. Arquivos/recursos locais (file:/data:/blob:) abrem SEMPRE em nova aba. Quando abre nova aba, retorna o tabId novo.", inputSchema: { type: "object", properties: { tabId: TABID, url: { type: "string" }, newTab: { type: "boolean", description: "abrir em NOVA aba (preserva a página de trabalho); retorna o tabId novo" }, active: { type: "boolean", description: "ao abrir nova aba, trazer para frente (padrão true; use false para abrir em segundo plano)" } }, required: ["url"] } },
  { name: "browser_history", cmd: "history", description: "Navegação da aba: voltar, avançar ou recarregar. Para HARD refresh (ignora o cache, tipo Ctrl+Shift+R) use action:'reload' com hard:true.", inputSchema: { type: "object", properties: { tabId: TABID, action: { type: "string", enum: ["back", "forward", "reload"] }, hard: { type: "boolean", description: "no reload, ignora o cache (hard refresh)" } }, required: ["action"] } },
  { name: "browser_reload_extension", cmd: "reload_extension", description: "Recarrega a PRÓPRIA extensão Claudão² (chrome.runtime.reload). Em instalação descompactada (dev), relê o código do disco — útil depois de editar o código da extensão: recarrega service worker + content scripts sem abrir chrome://extensions. A ponte cai e reconecta sozinha em segundos; abas já abertas podem precisar de refresh para a UI nova. Gated por uma opção do usuário (painel → Segurança → 'Permitir recarregar a extensão'). NÃO recarrega o mcp-server (processo do editor); mudanças nele exigem reiniciar o editor/MCP.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_move_cursor", cmd: "move_cursor", description: "Move o cursor vermelho visível até um elemento (selector/ref) ou coordenada (x,y), SEM clicar. Útil para demonstrar/ensinar.", inputSchema: { type: "object", properties: { tabId: TABID, selector: { type: "string" }, ref: { type: "string" }, x: { type: "number" }, y: { type: "number" } } } },
  { name: "browser_drag", cmd: "drag", description: "Arrasta (drag-and-drop) de um elemento de origem (selector/ref) para um destino (toSelector/toRef ou toX/toY). Dispara os eventos HTML5 de DnD.", inputSchema: { type: "object", properties: { tabId: TABID, selector: { type: "string" }, ref: { type: "string" }, toSelector: { type: "string" }, toRef: { type: "string" }, toX: { type: "number" }, toY: { type: "number" } } } },
  { name: "browser_upload", cmd: "upload", description: "Coloca arquivo(s) LOCAL(is) num <input type=file> direto pelo caminho (via CDP DOM.setFileInputFiles). É ASSIM que se anexa uma imagem/arquivo local a um formulário: NÃO navegue nem abra o arquivo no navegador — passe o 'selector' do input e 'files' (lista de caminhos absolutos) ou 'path'. Age na aba de trabalho sem trocá-la.", inputSchema: { type: "object", properties: { tabId: TABID, selector: { type: "string" }, files: { type: "array", items: { type: "string" } }, path: { type: "string" } }, required: ["selector"] } },
  // --- Multi-aba ---
  { name: "browser_open_tab", cmd: "open_tab", description: "Abre uma NOVA aba na URL dada e retorna o tabId novo — use para páginas/recursos auxiliares sem perder a aba onde está trabalhando. active=false abre em segundo plano (não rouba o foco).", inputSchema: { type: "object", properties: { url: { type: "string" }, active: { type: "boolean" } }, required: ["url"] } },
  { name: "browser_close_tab", cmd: "close_tab", description: "Fecha a aba de tabId dado.", inputSchema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] } },
  { name: "browser_activate_tab", cmd: "activate_tab", description: "Traz a aba de tabId dado para frente (foca a aba e a janela).", inputSchema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] } },
  // --- Login seguro e frictionless ---
  { name: "browser_login", cmd: "login", description: "Loga na página SEM setup: detecta o formulário de login sozinho, preenche usuário e senha e submete, esperando o pós-login. O segredo é protegido — não é logado nem ecoado, e é redigido em leituras posteriores. Passe 'password' direto, OU 'credentialEnv' (env var que o server resolve — o segredo não passa pelo modelo), OU 'credentialRef' (nome de uma credencial guardada no cofre da extensão — a extensão resolve, o modelo não vê o valor nem precisa de env var).", inputSchema: { type: "object", properties: { tabId: TABID, username: { type: "string" }, password: { type: "string", description: "senha (ou use credentialEnv/credentialRef)" }, credentialEnv: { type: "string", description: "nome da env var com a senha; o server resolve, o modelo não vê o valor" }, credentialRef: { type: "string", description: "nome de uma credencial do cofre da extensão (browser_credentials_list mostra os nomes); a extensão resolve usuário+senha" }, submit: { type: "boolean", description: "submeter após preencher (padrão true)" } } } },
  { name: "browser_fill_secret", cmd: "fill_secret", description: "Preenche um campo com um valor SENSÍVEL sem ele aparecer em retornos/logs. Use 'value' direto, 'credentialEnv' (resolvido pelo server) ou 'credentialRef' (resolvido do cofre da extensão).", inputSchema: { type: "object", properties: { tabId: TABID, selector: { type: "string" }, ref: { type: "string" }, value: { type: "string" }, credentialEnv: { type: "string" }, credentialRef: { type: "string", description: "nome de uma credencial do cofre da extensão" } } } },
  // --- Cofre de credenciais (a extensão guarda; o modelo só vê nomes, nunca valores) ---
  { name: "browser_credentials_list", cmd: "credentials_list", description: "Lista as credenciais guardadas no cofre da extensão: nome, domínio e usuário. NUNCA retorna a senha. Use o 'name' como credentialRef em browser_login/browser_fill_secret.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_credentials_save", cmd: "credentials_save", description: "Guarda uma credencial no cofre local da extensão para reuso (referenciar por credentialRef depois). O valor fica só na máquina do usuário e nunca é ecoado de volta.", inputSchema: { type: "object", properties: { name: { type: "string", description: "apelido da credencial (usado como credentialRef)" }, domain: { type: "string", description: "domínio ao qual pertence (ex.: meusite.com)" }, username: { type: "string" }, value: { type: "string", description: "a senha/segredo" } }, required: ["name", "value"] } },
  { name: "browser_credentials_delete", cmd: "credentials_delete", description: "Apaga uma credencial do cofre pelo nome (e domínio, opcional).", inputSchema: { type: "object", properties: { name: { type: "string" }, domain: { type: "string" } }, required: ["name"] } },

  { name: "browser_handoff", cmd: "handoff", description: "Passa a bola para o Claude NATIVO do navegador (ou lê a resposta dele). Envie 'message' com o que ele deve continuar — ele tem a sessão/login do Chrome e a MESMA memória persistente que você. O usuário vê um card no painel e clica para o Claude do navegador assumir. Use read:true para ler a resposta que o navegador/usuário deixou. Ideal quando o fluxo depende do login do navegador ou de uma decisão humana.", inputSchema: { type: "object", properties: { message: { type: "string", description: "o que o Claude do navegador deve continuar" }, task: { type: "string" }, read: { type: "boolean", description: "ler o handoff atual e a resposta do navegador" } } } },

  // Memória do Claudão² (o Claude externo pode ler e escrever a mesma memória persistente da extensão)
  { name: "memory_list", cmd: "memory_list", description: "Lista os documentos de memória do Claudão² (nome, se é fixado no contexto, tamanho).", inputSchema: { type: "object", properties: {} } },
  { name: "memory_read", cmd: "memory_read", description: "Lê o conteúdo completo de um documento de memória.", inputSchema: { type: "object", properties: { name: { type: "string", description: "ex.: perfil.md, memoria-viva.md" } }, required: ["name"] } },
  { name: "memory_search", cmd: "memory_search", description: "Busca por relevância nos documentos de memória não-fixados e retorna os trechos mais relevantes à consulta.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "memory_append", cmd: "memory_append", description: "Acrescenta um fato durável à memória (arquivo padrão memoria-viva.md, ou 'file' específico). Faz dedup automático.", inputSchema: { type: "object", properties: { text: { type: "string" }, file: { type: "string", description: "arquivo alvo, opcional" } }, required: ["text"] } },
  { name: "memory_write", cmd: "memory_write", description: "Cria ou sobrescreve um documento de memória inteiro. Use pinned=true para deixá-lo sempre no contexto.", inputSchema: { type: "object", properties: { name: { type: "string" }, content: { type: "string" }, pinned: { type: "boolean" } }, required: ["name", "content"] } },
  { name: "memory_delete", cmd: "memory_delete", description: "Apaga um documento de memória.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
];

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error("Ferramenta desconhecida: " + name);
  args = args || {};
  // Resolve credencial local: o segredo é lido do ambiente do SERVER (não do modelo).
  if (args.credentialEnv) {
    const v = process.env[args.credentialEnv];
    if (v == null) return { content: [{ type: "text", text: "Erro: variável de ambiente " + args.credentialEnv + " não está definida no ambiente do MCP server." }], isError: true };
    if (name === "browser_login") args.password = v; else args.value = v;
    delete args.credentialEnv;
  }
  const reply = await dispatch(tool.cmd, args);
  if (!reply.ok) return { content: [{ type: "text", text: "Erro: " + (reply.error || "falha desconhecida") }], isError: true };
  if (name === "browser_screenshot") {
    const du = reply.result && reply.result.dataUrl;
    if (!du) return { content: [{ type: "text", text: "Erro: sem screenshot" }], isError: true };
    const mime = (reply.result && reply.result.mime) || "image/png";
    return { content: [{ type: "image", data: du.replace(/^data:image\/[a-z]+;base64,/, ""), mimeType: mime }] };
  }
  if (name === "browser_look") {
    const r = reply.result || {};
    const content = [];
    if (r.dataUrl) content.push({ type: "image", data: r.dataUrl.replace(/^data:image\/[a-z]+;base64,/, ""), mimeType: r.mime || "image/jpeg" });
    const map = { url: r.url, title: r.title, size: (r.width && r.height) ? (r.width + "x" + r.height) : undefined, count: r.count, elements: r.elements };
    content.push({ type: "text", text: "Elementos numerados (o número = 'ref' para clicar/preencher, ex.: browser_click {ref:\"r3\"}):\n" + JSON.stringify(map, null, 2) });
    return { content };
  }
  const r = reply.result;
  return { content: [{ type: "text", text: (typeof r === "string" ? r : JSON.stringify(r, null, 2)) || "(vazio)" }] };
}

// ---------------------------------------------------------------------------
// MCP stdio (JSON-RPC 2.0, newline-delimited)
// ---------------------------------------------------------------------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    if (params && params.clientInfo && params.clientInfo.name) clientName = params.clientInfo.name;
    log("cliente MCP:", clientName);
    send({ jsonrpc: "2.0", id, result: { protocolVersion: (params && params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "claudao2-bridge", version: "1.0.0" } } });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") { send({ jsonrpc: "2.0", id, result: {} }); return; }
  if (method === "tools/list") { send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } }); return; }
  if (method === "tools/call") {
    try { send({ jsonrpc: "2.0", id, result: await callTool(params.name, params.arguments || {}) }); }
    catch (e) { send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Erro: " + (e && e.message || e) }], isError: true } }); }
    return;
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Método não suportado: " + method } });
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => log("handle erro:", e && e.message));
  }
});
process.stdin.on("end", () => process.exit(0));
log("MCP pronto (stdio). Ferramentas: " + TOOLS.map((t) => t.name).join(", "));
