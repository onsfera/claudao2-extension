/*
 * Claudão² Bridge — cliente no service worker.
 * --------------------------------------------
 * Conecta ao hub local (ws://127.0.0.1:8765), recebe comandos do Claude externo
 * (via o MCP server) e executa com chrome.tabs / chrome.scripting / chrome.debugger.
 *
 * - Depura abas em SEGUNDO PLANO (tabId explícito; screenshot via CDP, sem foco).
 * - Marca "atividade externa" enquanto o Claude externo age: glow vermelho na
 *   página + flag em storage (o sidepanel mostra banner e trava o input).
 * - Publica o status do hub em storage (a tela "Conectar VS Code" lê isso).
 */
(function () {
  "use strict";

  // Renomeia o grupo de abas que a extensão cria ("Claude" -> "Claudão²").
  // (1) intercepta chrome.tabGroups.update para não piscar; (2) listener de backup.
  try {
    if (chrome.tabGroups && chrome.tabGroups.update && !chrome.tabGroups.__cmPatched) {
      const origUpdate = chrome.tabGroups.update.bind(chrome.tabGroups);
      chrome.tabGroups.update = function (id, props, cb) {
        if (props && props.title === "Claude") props = { ...props, title: "Claudão²" };
        return origUpdate(id, props, cb);
      };
      chrome.tabGroups.__cmPatched = true;
    }
    chrome.tabGroups.onUpdated.addListener((g) => {
      if (g && g.title === "Claude") { try { chrome.tabGroups.update(g.id, { title: "Claudão²" }); } catch (_) {} }
    });
  } catch (_) {}

  const MEM = globalThis.ClaudeMemory; // core.js importado antes deste no loader
  const WS_URL = "ws://127.0.0.1:8765";
  const STATUS_KEY = "cm_bridge_status";   // {hubConnected, ts}
  const ACTIVE_KEY = "cm_external_active";  // {active, client, tab, ts}
  const ENABLED_KEY = "cm_bridge_enabled"; // opt-in: só conecta quando ligado
  const LOG_KEY = "cm_bridge_log";          // ring buffer de ações (auditoria no painel)
  const ALLOW_KEY = "cm_bridge_allowlist";  // domínios onde ações são permitidas
  const CONSENT_KEY = "cm_bridge_consent";  // pedido pendente de aprovação (SW -> painel)
  const GRANT_KEY = "cm_bridge_grant";      // resposta do painel (painel -> SW): {host, scope, ts}
  const ALLOWALL_KEY = "cm_bridge_allow_all"; // aprovar tudo automaticamente (padrão: sim)
  const EXTRELOAD_KEY = "cm_allow_ext_reload"; // deixar o Claude externo recarregar a extensão (padrão: sim)
  const VAULT_KEY = "cm_vault";             // credenciais do cofre {items:[{id,domain,name,username,value}]}
  const PAUSE_KEY = "cm_external_paused";   // "Parar Claude": recusa comandos até retomar
  const REDACTPII_KEY = "cm_redact_pii";    // borrar campos sensíveis nas screenshots (padrão: não)
  const HANDOFF_KEY = "cm_handoff";         // passagem de tarefa Claude-editor <-> Claude-navegador
  const DEFAULT_ALLOW = ["localhost", "127.0.0.1"];
  const ACTIVE_IDLE_MS = 12000;             // trava/banner só somem após esse ocioso (evita piscar entre comandos)
  // Comandos que MODIFICAM/interagem (exigem domínio aprovado). Percepção é livre.
  const ACTION_CMDS = { click: 1, fill: 1, type: 1, press: 1, hover: 1, scroll: 1, select: 1, submit: 1, navigate: 1, history: 1, login: 1, fill_secret: 1, upload: 1, drag: 1, open_tab: 1 };

  let ws = null;
  let enabled = false;
  let attempts = 0;
  let scheduled = false;

  async function setStatus(hubConnected) {
    try { await chrome.storage.local.set({ [STATUS_KEY]: { hubConnected, ts: Date.now() } }); } catch (_) {}
  }

  // Backoff adaptativo: rápido nas primeiras tentativas (setup), lento depois
  // (minimiza erros de conexão no console quando o hub não está de pé).
  function nextDelay() {
    attempts++;
    return attempts <= 6 ? Math.min(Math.round(1000 * Math.pow(1.6, attempts)), 8000) : 30000;
  }

  function connect() {
    if (!enabled) return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    try { ws = new WebSocket(WS_URL); } catch (e) { return schedule(); }
    ws.onopen = () => {
      attempts = 0;
      setStatus(true);
      try { ws.send(JSON.stringify({ type: "hello", info: { ext: "Claudão²", ver: chrome.runtime.getManifest().version } })); } catch (_) {}
    };
    ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && msg.type === "server_hello") {
        // O server informa seu caminho real nesta máquina → guardamos p/ a tela Conectar
        // mostrar o comando exato (a extensão não tem como saber o próprio path no disco).
        try { chrome.storage.local.set({ cm_bridge_paths: { install: msg.installPath || "", server: msg.serverPath || "", ts: Date.now() } }); } catch (_) {}
        return;
      }
      if (!msg || !msg.cmd) return;
      // "Parar Claude": se o usuário pausou (botão na tela ou assumiu o controle), recusa tudo.
      {
        let pv = null; try { pv = (await chrome.storage.local.get(PAUSE_KEY))[PAUSE_KEY]; } catch (_) {}
        if (pv && pv.on) {
          const why = pv.reason === "takeover" ? "O usuário ASSUMIU o controle (mexeu na página)" : "O usuário clicou em PARAR CLAUDE";
          try { ws.send(JSON.stringify({ id: msg.id, ok: false, paused: true, error: why + ". A interação está PAUSADA por decisão do usuário. PARE agora: NÃO repita a chamada automaticamente. Pergunte a ele o que ajustar, ou espere ele clicar em Retomar (na página ou no painel)." })); } catch (_) {}
          return;
        }
      }
      let reply, tabId = null, host = "";
      try {
        const TAB_CMDS = { read: 1, console: 1, eval: 1, screenshot: 1, click: 1, fill: 1, navigate: 1, query: 1, snapshot: 1, get_state: 1, network: 1, wait: 1, type: 1, press: 1, hover: 1, scroll: 1, select: 1, submit: 1, history: 1, login: 1, fill_secret: 1, upload: 1, move_cursor: 1, drag: 1, look: 1, mark: 1, inspect: 1, observe: 1 };
        const needsTab = !!TAB_CMDS[msg.cmd];
        tabId = needsTab ? await resolveTab(msg.args || {}) : null;
        if (tabId) { try { const tb = await chrome.tabs.get(tabId); host = hostOf(tb.url || ""); } catch (_) {} }
        // Gate de allowlist: ações só rodam em domínios aprovados (navigate/open_tab checam o destino).
        const a = msg.args || {};
        const gateHost = ((msg.cmd === "navigate" || msg.cmd === "open_tab") && a.url) ? hostOf(a.url) : host;
        if (ACTION_CMDS[msg.cmd] && !(await hostAllowed(gateHost))) {
          await raiseConsent(gateHost, msg.cmd, msg.client);
          reply = { ok: false, needsConsent: true, host: gateHost, error: "Ação em '" + (gateHost || "esta aba") + "' precisa da sua aprovação. Abra o painel do Claudão² (ícone de tomada) → aprove este site, e repita a ação." };
        } else {
          await markActive(msg.client, tabId);      // glow + flag ANTES de agir
          // Trava por aba: comandos na MESMA aba serializam (evita colisão de
          // debugger/DOM entre editores); abas diferentes seguem em paralelo.
          reply = await withTabLock(tabId, () => exec(msg, tabId, host));
          // redação: mascara segredos conhecidos em qualquer retorno textual. No look,
          // redige o texto (elements/url/title) mas preserva o dataUrl (não varre o base64).
          if (reply && reply.ok && reply.result !== undefined && msg.cmd !== "screenshot") {
            if (msg.cmd === "look" && reply.result && reply.result.dataUrl) {
              const du = reply.result.dataUrl; reply.result.dataUrl = null;
              reply.result = redactDeep(reply.result); reply.result.dataUrl = du;
            } else {
              reply.result = redactDeep(reply.result);
            }
          }
        }
      } catch (e) {
        reply = { ok: false, error: String((e && e.message) || e) };
      }
      logAction({ t: Date.now(), cmd: msg.cmd, client: msg.client || "", tabId: tabId || null, host, ok: !!(reply && reply.ok), error: reply && reply.error ? String(reply.error).slice(0, 140) : "", needsConsent: !!(reply && reply.needsConsent), summary: summarizeArgs(msg.cmd, msg.args) });
      try { ws.send(JSON.stringify({ id: msg.id, ...reply })); } catch (_) {}
    };
    ws.onclose = () => { setStatus(false); if (enabled) schedule(); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  function schedule() {
    if (!enabled || scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; connect(); }, nextDelay());
  }

  function disconnect() {
    try { if (ws) ws.close(); } catch (_) {}
    ws = null;
    setStatus(false);
  }

  async function applyEnabled(next) {
    const was = enabled;
    enabled = !!next;
    if (enabled && !was) { attempts = 0; connect(); }
    else if (!enabled && was) { disconnect(); }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[ENABLED_KEY]) applyEnabled(changes[ENABLED_KEY].newValue && changes[ENABLED_KEY].newValue.on);
    // O painel aprovou "só nesta sessão" um domínio → guarda em memória do SW.
    if (changes[GRANT_KEY] && changes[GRANT_KEY].newValue) {
      const g = changes[GRANT_KEY].newValue;
      if (g && g.host && g.scope === "session") sessionConsent.add(g.host);
    }
    // "Parar Claude": ao pausar, remove o glow e mostra a pílula "Retomar" nas abas;
    // ao retomar (on:false), tira a pílula (o glow volta quando o Claude agir de novo).
    if (changes[PAUSE_KEY]) {
      const pv = changes[PAUSE_KEY].newValue;
      if (pv && pv.on) {
        clearTimeout(clearTimer);
        for (const t of glowedTabs) { glow(t, false); showResume(t, true); pausedTabs.add(t); }
        glowedTabs.clear();
        try { chrome.storage.local.set({ [ACTIVE_KEY]: { active: false, ts: Date.now() } }); } catch (_) {}
      } else {
        for (const t of pausedTabs) showResume(t, false);
        pausedTabs.clear();
      }
    }
  });

  // Painel (content script) pede ao SW para cifrar+guardar uma credencial — a
  // chave do cofre vive só no SW, então o painel delega a cifra pra cá.
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.cm_vault === "save" && msg.item) {
        addSecret(msg.item.value);
        vaultSave(msg.item).then((r) => sendResponse({ ok: true, result: r })).catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
        return true; // resposta assíncrona
      }
    });
  } catch (_) {}

  try {
    chrome.alarms.create("cm_bridge_keepalive", { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((a) => {
      if (a.name === "cm_bridge_keepalive" && enabled && (!ws || ws.readyState > 1)) connect();
    });
  } catch (_) {}
  try { chrome.runtime.onStartup.addListener(() => { if (enabled) connect(); }); } catch (_) {}

  // Estado inicial: LIGADO por padrão (o VS Code chama a extensão sem o usuário
  // precisar abrir nada). Fica gravado; o usuário pode desligar na tela Conectar.
  (async () => {
    try {
      const v = (await chrome.storage.local.get(ENABLED_KEY))[ENABLED_KEY];
      if (v == null) { enabled = true; try { await chrome.storage.local.set({ [ENABLED_KEY]: { on: true, ts: Date.now() } }); } catch (_) {} }
      else enabled = !!(v && v.on);
    } catch (_) {}
    if (enabled) connect();
  })();

  // -------------------------------------------------------------------------
  // Redação de segredos: valores usados em login/fill_secret são mascarados
  // em qualquer retorno textual posterior (read/console/network/query/eval...).
  // -------------------------------------------------------------------------
  const redactSet = new Set();
  function addSecret(v) { if (v && String(v).length >= 3) redactSet.add(String(v)); }
  function redact(text) {
    if (typeof text !== "string" || !redactSet.size) return text;
    let out = text;
    for (const s of redactSet) if (s) out = out.split(s).join("•••");
    return out;
  }
  function redactDeep(obj) {
    if (typeof obj === "string") return redact(obj);
    if (Array.isArray(obj)) return obj.map(redactDeep);
    if (obj && typeof obj === "object") { const o = {}; for (const k in obj) o[k] = redactDeep(obj[k]); return o; }
    return obj;
  }

  // -------------------------------------------------------------------------
  // Allowlist + consentimento: ações só rodam em domínios aprovados. Fora deles,
  // levanta um pedido de consentimento no painel e devolve erro (o modelo repete
  // depois que o usuário aprova). Perception (read/console/etc.) é sempre livre.
  // -------------------------------------------------------------------------
  const sessionConsent = new Set(); // domínios aprovados só nesta sessão do SW
  function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ""; } }
  function hostMatches(host, entry) {
    if (!host || !entry) return false;
    entry = String(entry).toLowerCase(); host = host.toLowerCase();
    return host === entry || host.endsWith("." + entry);
  }
  async function getAllowlist() {
    try { const v = (await chrome.storage.local.get(ALLOW_KEY))[ALLOW_KEY]; if (Array.isArray(v) && v.length) return v; } catch (_) {}
    return DEFAULT_ALLOW.slice();
  }
  async function getAllowAll() {
    try { const v = (await chrome.storage.local.get(ALLOWALL_KEY))[ALLOWALL_KEY]; return v == null ? true : !!v; } catch (_) { return true; }
  }
  async function getAllowExtReload() {
    try { const v = (await chrome.storage.local.get(EXTRELOAD_KEY))[EXTRELOAD_KEY]; return v == null ? true : !!v; } catch (_) { return true; }
  }
  async function getRedactPII() {
    try { return !!(await chrome.storage.local.get(REDACTPII_KEY))[REDACTPII_KEY]; } catch (_) { return false; }
  }
  // Desenha tarjas pretas sobre bboxes (viewport) numa imagem base64, via OffscreenCanvas (SW).
  async function redactImage(dataUrl, boxes, factor) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const bmp = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      ctx.fillStyle = "#000";
      for (const b of boxes) ctx.fillRect(Math.round(b.x * factor), Math.round(b.y * factor), Math.round(b.w * factor), Math.round(b.h * factor));
      const mime = dataUrl.startsWith("data:image/png") ? "image/png" : "image/jpeg";
      const outBlob = await canvas.convertToBlob({ type: mime, quality: 0.72 });
      const bytes = new Uint8Array(await outBlob.arrayBuffer());
      let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return "data:" + mime + ";base64," + btoa(bin);
    } catch (_) { return dataUrl; }
  }
  async function hostAllowed(host) {
    if (await getAllowAll()) return true;   // dono liberou tudo (padrão) → sem consentimento
    if (!host) return false;
    if (sessionConsent.has(host)) return true;
    const list = await getAllowlist();
    return list.some((e) => hostMatches(host, e));
  }
  async function raiseConsent(host, cmd, client) {
    try { await chrome.storage.local.set({ [CONSENT_KEY]: { host: host || "", cmd, client: client || "Claude externo", ts: Date.now() } }); } catch (_) {}
  }

  // -------------------------------------------------------------------------
  // Log de ações (auditoria visível no painel). Nunca guarda segredos.
  // -------------------------------------------------------------------------
  function summarizeArgs(cmd, a) {
    a = a || {};
    const pick = [];
    if (a.url) pick.push(a.url.slice(0, 80));
    if (a.selector) pick.push(a.selector.slice(0, 60));
    if (a.ref) pick.push("ref:" + a.ref);
    if (a.text) pick.push('"' + String(a.text).slice(0, 40) + '"');
    if (a.key) pick.push("key:" + a.key);
    if (a.action) pick.push(a.action);
    if (a.format) pick.push(a.format);
    if (a.username) pick.push("user:" + String(a.username).slice(0, 40));
    if (a.name && (cmd || "").startsWith("memory")) pick.push(a.name);
    if (a.credentialRef) pick.push("cofre:" + a.credentialRef);
    return pick.join(" ").slice(0, 140); // password/value NUNCA entram aqui
  }
  // Serializa as escritas do log (read-modify-write) para não perder entradas
  // quando dois editores agem ao mesmo tempo.
  let logChain = Promise.resolve();
  function logAction(entry) {
    logChain = logChain.then(async () => {
      try {
        const cur = (await chrome.storage.local.get(LOG_KEY))[LOG_KEY];
        const arr = Array.isArray(cur) ? cur : [];
        arr.push(entry);
        while (arr.length > 200) arr.shift();
        await chrome.storage.local.set({ [LOG_KEY]: arr });
      } catch (_) {}
    }, () => {});
    return logChain;
  }

  // Trava por aba: uma fila de promessas por tabId. Comandos no mesmo tabId
  // rodam em sequência; tabIds diferentes rodam em paralelo. tabId nulo (tabs,
  // memória, cofre, multi-aba) não trava.
  const tabChains = new Map();
  function withTabLock(tabId, fn) {
    if (tabId == null) return Promise.resolve().then(fn);
    const prev = tabChains.get(tabId) || Promise.resolve();
    const run = prev.then(() => fn(), () => fn());
    tabChains.set(tabId, run.then(() => {}, () => {}));
    return run;
  }

  // -------------------------------------------------------------------------
  // Cifra do cofre (device-bound, frictionless): chave AES-GCM NÃO-exportável
  // guardada no IndexedDB da extensão. O código usa a chave mas nunca extrai os
  // bytes dela; o chrome.storage guarda só {iv,ct}. Sem senha-mestra/desbloqueio.
  // -------------------------------------------------------------------------
  const VKEY_DB = "cm_vault_keys", VKEY_STORE = "keys", VKEY_ID = "vaultKey";
  function vkIdb() { return new Promise((res, rej) => { const r = indexedDB.open(VKEY_DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(VKEY_STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  function vkGet(db, k) { return new Promise((res, rej) => { const t = db.transaction(VKEY_STORE, "readonly").objectStore(VKEY_STORE).get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); }
  function vkPut(db, k, v) { return new Promise((res, rej) => { const t = db.transaction(VKEY_STORE, "readwrite").objectStore(VKEY_STORE).put(v, k); t.onsuccess = () => res(); t.onerror = () => rej(t.error); }); }
  let vaultKeyP = null;
  async function vaultKey() {
    if (vaultKeyP) return vaultKeyP;
    vaultKeyP = (async () => {
      const db = await vkIdb();
      let key = await vkGet(db, VKEY_ID);
      if (!key) { key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); await vkPut(db, VKEY_ID, key); }
      return key;
    })();
    return vaultKeyP;
  }
  function b64e(buf) { let s = ""; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function b64d(str) { const s = atob(str); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
  async function encSecret(plain) {
    try { const key = await vaultKey(); const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(String(plain == null ? "" : plain))); return { iv: b64e(iv), ct: b64e(ct) }; }
    catch (_) { return { plain: String(plain == null ? "" : plain) }; } // degrada p/ texto se crypto indisponível
  }
  async function decSecret(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;   // legado (texto puro pré-cifra)
    if (v.plain != null) return v.plain;   // fallback sem cifra
    try { const key = await vaultKey(); const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(v.iv) }, key, b64d(v.ct)); return new TextDecoder().decode(pt); }
    catch (_) { return ""; }
  }

  // -------------------------------------------------------------------------
  // Cofre de credenciais (chrome.storage.local, valores cifrados). O modelo
  // nunca lê o valor: passa credentialRef (nome) e o SW resolve+decifra aqui.
  // -------------------------------------------------------------------------
  async function vaultItems() {
    try { const v = (await chrome.storage.local.get(VAULT_KEY))[VAULT_KEY]; if (v && Array.isArray(v.items)) return v.items; } catch (_) {}
    return [];
  }
  async function resolveCredential(ref, host) {
    if (!ref) return null;
    const items = await vaultItems();
    let hit = items.find((it) => it.name === ref && (!host || hostMatches(host, it.domain)));
    if (!hit) hit = items.find((it) => it.name === ref);
    if (!hit) return null;
    return { ...hit, value: await decSecret(hit.value) }; // decifra só na hora de usar
  }
  async function vaultSave(item) {
    const items = await vaultItems();
    const id = item.id || (item.domain + "/" + item.name);
    const idx = items.findIndex((it) => (it.id || (it.domain + "/" + it.name)) === id || (it.domain === item.domain && it.name === item.name));
    const rec = { id, domain: (item.domain || "").toLowerCase(), name: item.name || "cred", username: item.username || "", value: await encSecret(item.value || ""), ts: Date.now() };
    if (idx >= 0) items[idx] = { ...items[idx], ...rec }; else items.push(rec);
    await chrome.storage.local.set({ [VAULT_KEY]: { items } });
    return { id: rec.id, domain: rec.domain, name: rec.name };
  }
  async function vaultDelete(name, domain) {
    const items = (await vaultItems()).filter((it) => !(it.name === name && (!domain || it.domain === domain)));
    await chrome.storage.local.set({ [VAULT_KEY]: { items } });
    return { deleted: name };
  }

  // -------------------------------------------------------------------------
  // Atividade externa: glow na página + flag para o sidepanel
  // -------------------------------------------------------------------------
  const glowedTabs = new Set(); // TODAS as abas com glow (não uma só) — apaga todas ao encerrar
  const pausedTabs = new Set(); // abas que receberam a pílula "Retomar" ao pausar
  let clearTimer = null;
  const GLOW_TTL_MS = 15000;    // overlay se auto-remove se não renovado (sobrevive à morte do SW)

  async function isPaused() {
    try { const v = (await chrome.storage.local.get(PAUSE_KEY))[PAUSE_KEY]; return !!(v && v.on); } catch (_) { return false; }
  }
  function unglowAll() { for (const t of glowedTabs) glow(t, false); glowedTabs.clear(); }

  async function markActive(client, tabId) {
    if (tabId) glowedTabs.add(tabId);
    try {
      await chrome.storage.local.set({ [ACTIVE_KEY]: { active: true, client: client || "Claude externo", tab: tabId || null, ts: Date.now() } });
    } catch (_) {}
    if (tabId) glow(tabId, true, client);
    clearTimeout(clearTimer);
    clearTimer = setTimeout(clearActive, ACTIVE_IDLE_MS);
  }
  async function clearActive() {
    clearTimeout(clearTimer);
    try {
      const cur = (await chrome.storage.local.get(ACTIVE_KEY))[ACTIVE_KEY];
      if (cur && cur.active && Date.now() - (cur.ts || 0) < ACTIVE_IDLE_MS - 200) {
        clearTimer = setTimeout(clearActive, ACTIVE_IDLE_MS); // ainda ativo, reagenda
        return;
      }
      await chrome.storage.local.set({ [ACTIVE_KEY]: { active: false, ts: Date.now() } });
    } catch (_) {}
    unglowAll();
  }

  // Injeta na aba: borda neon + botão "Parar Claude" + auto-pausa se o usuário mexer.
  // O overlay renova um timestamp e se remove sozinho se não for renovado (backstop
  // contra o service worker dormir). glowedTabs garante a limpeza multi-aba explícita.
  async function glow(tabId, on, client) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (show, label, ttl, pauseKey) => {
          const IDS = ["__claudao_glow__", "__claudao_cursor__", "__claudao_marks__", "__claudao_stop__"];
          if (!show) {
            IDS.forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
            if (window.__claudaoGlowInt) { clearInterval(window.__claudaoGlowInt); window.__claudaoGlowInt = null; }
            return;
          }
          window.__claudaoGlowTs = Date.now(); // renova (mantém vivo)
          window.__claudaoActUntil = Date.now() + 2000; // janela de "agindo agora" p/ o takeover
          if (!document.getElementById("__claudao_glow__")) {
            const d = document.createElement("div"); d.id = "__claudao_glow__";
            d.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;box-shadow:inset 0 0 0 3px rgba(255,64,64,.95), inset 0 0 42px rgba(255,64,64,.5);animation:__claudaoGlow 1.6s ease-in-out infinite;";
            const s = document.createElement("style"); s.textContent = "@keyframes __claudaoGlow{0%,100%{opacity:.55}50%{opacity:1}}";
            d.appendChild(s); (document.body || document.documentElement).appendChild(d);
          }
          if (!document.getElementById("__claudao_stop__")) {
            const btn = document.createElement("button"); btn.id = "__claudao_stop__";
            btn.innerHTML = "⏹ Parar Claude" + (label ? " <span style='opacity:.7;font-weight:400'>· " + String(label).slice(0, 24) + "</span>" : "");
            btn.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#c0392b;color:#fff;border:none;border-radius:9px;padding:8px 16px;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 3px 14px rgba(0,0,0,.45);pointer-events:auto;";
            btn.onclick = (e) => { e.stopPropagation(); try { chrome.storage.local.set({ [pauseKey]: { on: true, ts: Date.now(), reason: "button" } }); } catch (_) {} btn.textContent = "Pausado"; btn.style.background = "#7a1f1f"; };
            (document.body || document.documentElement).appendChild(btn);
          }
          if (!window.__claudaoGlowInt) {
            window.__claudaoGlowInt = setInterval(() => {
              if (Date.now() - (window.__claudaoGlowTs || 0) > (ttl || 15000)) {
                IDS.forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
                clearInterval(window.__claudaoGlowInt); window.__claudaoGlowInt = null;
              }
            }, 3000);
          }
          // auto-pausa: input REAL do usuário com glow ativo = "assumi o controle"
          if (!window.__claudaoTakeoverBound) {
            window.__claudaoTakeoverBound = true;
            const onUser = (ev) => {
              if (!ev.isTrusted) return;
              if (ev.target && ev.target.id === "__claudao_stop__") return; // o botão já pausa
              if (!document.getElementById("__claudao_glow__")) return;      // só com glow ativo
              if (Date.now() > (window.__claudaoActUntil || 0)) return;      // só se o Claude agiu nos últimos ~2s
              try { chrome.storage.local.set({ [pauseKey]: { on: true, ts: Date.now(), reason: "takeover" } }); } catch (_) {}
            };
            addEventListener("mousedown", onUser, true);
            addEventListener("keydown", onUser, true);
          }
        },
        args: [!!on, client || "", GLOW_TTL_MS, PAUSE_KEY],
      });
    } catch (_) {}
  }

  // Pílula "▶ Retomar Claude" na própria página onde o usuário pausou (o "Retomar" do
  // painel pode não estar visível se ele está olhando a aba alvo).
  async function showResume(tabId, on) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (show, pauseKey) => {
          const ID = "__claudao_resume__";
          const old = document.getElementById(ID); if (old) old.remove();
          if (!show) return;
          const btn = document.createElement("button"); btn.id = ID;
          btn.textContent = "▶ Retomar Claude";
          btn.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1f7a3a;color:#fff;border:none;border-radius:9px;padding:8px 16px;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 3px 14px rgba(0,0,0,.45);pointer-events:auto;";
          btn.onclick = (e) => { e.stopPropagation(); try { chrome.storage.local.set({ [pauseKey]: { on: false, ts: Date.now() } }); } catch (_) {} btn.remove(); };
          (document.body || document.documentElement).appendChild(btn);
        },
        args: [!!on, PAUSE_KEY],
      });
    } catch (_) {}
  }

  // -------------------------------------------------------------------------
  // Execução dos comandos
  // -------------------------------------------------------------------------
  async function resolveTab(a) {
    if (a && a.tabId) return a.tabId;
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!t) throw new Error("nenhuma aba ativa encontrada");
    return t.id;
  }
  // Regra: recurso/arquivo auxiliar NUNCA deve substituir a aba de trabalho.
  // navigate abre em nova aba se newTab=true OU se for arquivo/recurso local.
  function navOpensNewTab(url, newTab) { return !!newTab || /^(file|data|blob):/i.test(String(url || "")); }

  async function withDebugger(tabId, fn) {
    const target = { tabId };
    await chrome.debugger.attach(target, "1.3");
    try { return await fn(target); }
    finally { try { await chrome.debugger.detach(target); } catch (_) {} }
  }

  async function evalInTab(tabId, code) {
    return withDebugger(tabId, async (target) => {
      const r = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: code, returnByValue: true, awaitPromise: true, userGesture: true, allowUnsafeEvalBlockedByCSP: true,
      });
      if (r && r.exceptionDetails) {
        const ex = r.exceptionDetails;
        return { error: (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || "erro na avaliação" };
      }
      const res = r && r.result;
      return { value: res ? (("value" in res) ? res.value : res.description) : null, type: res && res.type };
    });
  }

  async function screenshotTab(tabId, opts) {
    // CDP: captura mesmo em segundo plano, sem trazer a aba para frente.
    // Barato por padrão: JPEG + qualidade + teto de resolução (downscale via clip.scale),
    // considerando o devicePixelRatio para o teto valer em PIXELS FÍSICOS.
    opts = opts || {};
    const format = opts.format === "png" ? "png" : "jpeg";
    const quality = Math.max(20, Math.min(95, opts.quality || 72));
    const maxWidth = opts.maxWidth || 1280;
    const redactOn = opts.redactPII != null ? !!opts.redactPII : await getRedactPII();
    const wantPII = redactOn && !opts.fullPage && !opts.selector; // redação só no viewport (coords batem)
    // Uma injeção pega o DPR, o rect do elemento (se selector) e as bboxes de PII (se redação).
    let info = { dpr: 1, rect: null, pii: [] };
    try {
      const [b] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel, wantPII) => {
          let rect = null;
          if (sel) { const e = document.querySelector(sel); if (e) { e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); rect = { x: r.left, y: r.top, width: r.width, height: r.height }; } }
          const pii = [];
          if (wantPII) {
            const psel = 'input[type=password],input[type=email],input[type=tel],input[autocomplete*="cc-"],input[autocomplete="email"],input[autocomplete="tel"],input[name*="card" i],input[name*="cpf" i],input[name*="senha" i],input[name*="cartao" i]';
            try { for (const e of document.querySelectorAll(psel)) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) pii.push({ x: Math.max(0, r.left), y: Math.max(0, r.top), w: r.width, h: r.height }); } } catch (_) {}
          }
          return { dpr: window.devicePixelRatio || 1, rect, pii };
        },
        args: [opts.selector || "", wantPII],
      });
      if (b && b.result) info = b.result;
    } catch (_) {}
    return withDebugger(tabId, async (target) => {
      const m = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics", {});
      let clip = null, beyond = false;
      if (opts.selector && info.rect) {
        // Elemento já rolado à vista → clip viewport-relativo, sem captureBeyondViewport.
        clip = { x: Math.max(0, info.rect.x), y: Math.max(0, info.rect.y), width: Math.ceil(info.rect.width) || 1, height: Math.ceil(info.rect.height) || 1 }; beyond = false;
      } else if (opts.fullPage) {
        const cs = (m && (m.cssContentSize || m.contentSize)); if (cs) clip = { x: 0, y: 0, width: Math.ceil(cs.width), height: Math.ceil(cs.height) }; beyond = true;
      } else {
        const vp = (m && (m.cssLayoutViewport || m.layoutViewport)); if (vp) clip = { x: 0, y: 0, width: Math.ceil(vp.clientWidth), height: Math.ceil(vp.clientHeight) }; beyond = false;
      }
      const dpr = info.dpr || 1;
      const baseW = clip ? clip.width : 0;
      // físico = baseW * dpr * scale ; cap em maxWidth (nunca ampliar)
      const scale = baseW ? Math.min(1, maxWidth / (baseW * dpr)) : 1;
      const shot = { format, captureBeyondViewport: beyond };
      if (format === "jpeg") shot.quality = quality;
      if (clip) shot.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale };
      const { data } = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", shot);
      let dataUrl = "data:image/" + format + ";base64," + data, redacted = 0;
      if (wantPII && info.pii && info.pii.length) { dataUrl = await redactImage(dataUrl, info.pii, scale * dpr); redacted = info.pii.length; }
      return { dataUrl, mime: "image/" + format, width: clip ? Math.round(clip.width * scale * dpr) : null, height: clip ? Math.round(clip.height * scale * dpr) : null, scale: Math.round(scale * 100) / 100, redacted };
    });
  }

  // "Agente de página" unificado, injetado via executeScript (self-contained):
  // resolve elemento por selector/ref/texto, mostra cursor vermelho animado,
  // espera visibilidade, e executa a operação (click/fill/type/hover/scroll/
  // select/submit/query/snapshot/get_state/wait/read/login). Sem chrome.debugger
  // (não mostra a barra amarela) para as ações de DOM.
  function agentDispatch(p) {
    return (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const CID = "__claudao_cursor__";
      function ensureCursor() {
        let cur = document.getElementById(CID);
        if (!cur) {
          cur = document.createElement("div"); cur.id = CID;
          cur.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:transform .45s cubic-bezier(.22,1,.36,1);will-change:transform;filter:drop-shadow(0 2px 4px rgba(0,0,0,.4));";
          cur.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="#ff3b3b" stroke="#fff" stroke-width="1.5"><path d="M4 2l6.5 18 2.4-7.1L20 10.5z"/></svg>' +
            '<span class="__cl_lbl" style="position:absolute;left:19px;top:6px;white-space:nowrap;background:#ff3b3b;color:#fff;font:600 11px/1.5 system-ui,sans-serif;padding:1px 7px;border-radius:7px;box-shadow:0 1px 4px rgba(0,0,0,.4);opacity:0;transition:opacity .2s;"></span>';
          document.documentElement.appendChild(cur);
        }
        if (!document.getElementById("__claudao_kf")) {
          const st = document.createElement("style"); st.id = "__claudao_kf";
          st.textContent = "@keyframes __claudaoRipple{to{transform:scale(3.6);opacity:0}}";
          document.documentElement.appendChild(st);
        }
        return cur;
      }
      function cursorLabel(text) {
        const lbl = ensureCursor().querySelector(".__cl_lbl"); if (!lbl) return;
        if (text) { lbl.textContent = text; lbl.style.opacity = "1"; } else { lbl.style.opacity = "0"; }
      }
      // Destaque momentâneo de um elemento (o usuário vê "olhando aqui").
      function flash(el) {
        try {
          const r = el.getBoundingClientRect();
          const h = document.createElement("div");
          h.style.cssText = "position:fixed;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px;border:2px solid #ff3b3b;border-radius:4px;background:rgba(255,59,59,.12);z-index:2147483646;pointer-events:none;transition:opacity .5s;box-sizing:border-box;";
          document.documentElement.appendChild(h);
          setTimeout(() => { h.style.opacity = "0"; }, 550);
          setTimeout(() => h.remove(), 1100);
        } catch (_) {}
      }
      function visible(el) { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0"; }
      function resolveEl(a) {
        if (a.ref) { try { return document.querySelector('[data-cm-ref="' + a.ref + '"]'); } catch (_) { return null; } }
        if (a.selector) { try { return document.querySelector(a.selector); } catch (_) { return null; } }
        if (a.text) { const t = String(a.text).toLowerCase(); return [...document.querySelectorAll("a,button,[role=button],[role=link],input[type=submit],input[type=button],summary")].find((e) => ((e.textContent || e.value || "") + "").trim().toLowerCase().includes(t)) || null; }
        return null;
      }
      async function waitVisible(a, timeout) {
        const t0 = Date.now();
        while (Date.now() - t0 < (timeout || 6000)) { const el = resolveEl(a); if (el && visible(el)) return el; await sleep(120); }
        return resolveEl(a);
      }
      function setVal(el, val) {
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const s = Object.getOwnPropertyDescriptor(proto, "value");
        if (s && s.set) s.set.call(el, val); else el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      async function moveTo(el) {
        const cur = ensureCursor();
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(360);
        const r = el.getBoundingClientRect();
        const x = r.left + Math.min(r.width / 2, 18), y = r.top + Math.min(r.height / 2, 10);
        cur.style.transform = "translate(" + x + "px," + y + "px)";
        await sleep(470);
        return { x, y };
      }
      function ripple(x, y) {
        const rp = document.createElement("div");
        rp.style.cssText = "position:fixed;left:" + x + "px;top:" + y + "px;z-index:2147483646;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:rgba(255,59,59,.35);border:2px solid #ff3b3b;pointer-events:none;animation:__claudaoRipple .5s ease-out forwards;";
        document.documentElement.appendChild(rp);
        setTimeout(() => rp.remove(), 520);
      }
      // Confiabilidade: detectar erros de validação, spinners e modais.
      function detectErrors() {
        const out = [];
        try {
          const sel = '[role=alert],[aria-invalid="true"],.error,.is-invalid,.invalid-feedback,.field-error,.form-error,.error-message,.errorMessage';
          for (const e of document.querySelectorAll(sel)) {
            if (!visible(e)) continue;
            let t = e.getAttribute("aria-invalid") === "true" ? (e.getAttribute("aria-label") || e.getAttribute("name") || e.placeholder || "campo inválido") : (e.textContent || "");
            t = (t || "").replace(/\s+/g, " ").trim();
            if (t && t.length <= 160) out.push(t);
            if (out.length >= 8) break;
          }
        } catch (_) {}
        return [...new Set(out)];
      }
      function findSpinner() { try { return [...document.querySelectorAll('[role=progressbar],[aria-busy="true"],.spinner,.loader,.loading-spinner')].find(visible) || null; } catch (_) { return null; } }
      function topModal() { try { const els = [...document.querySelectorAll('[role=dialog],[aria-modal="true"],.modal,dialog[open]')].filter(visible); return els.length ? els[els.length - 1] : null; } catch (_) { return null; } }
      async function settleSpinner(max) { if (!findSpinner()) return; const t0 = Date.now(); while (Date.now() - t0 < (max || 3000)) { if (!findSpinner()) return; await sleep(150); } }

      const op = p.op;
      try {
        if (op === "click") {
          await settleSpinner();
          const el = await waitVisible(p, p.timeoutMs); if (!el) return { ok: false, error: "elemento não encontrado" };
          if (el.tagName === "INPUT" && el.type === "file") return { ok: false, error: "Este é um <input type=file>: clicar abriria o seletor de arquivos do sistema (trava o agente). Use browser_upload com o caminho do arquivo NESTE input, em vez de clicar." };
          try { document.documentElement.removeAttribute("data-cm-fileblocked"); } catch (_) {}
          const before = { url: location.href, n: document.body ? document.body.childElementCount : 0 };
          cursorLabel(p.label || "Clicando"); const c = await moveTo(el); ripple(c.x, c.y); await sleep(110); el.click(); cursorLabel("");
          await sleep(220);
          const navigated = location.href !== before.url;
          const changed = navigated || (document.body && document.body.childElementCount !== before.n);
          const r = { ok: true, clicked: true, changed: !!changed, navigated };
          if (document.documentElement.getAttribute("data-cm-fileblocked")) { r.filePickerBlocked = true; r.hint = "O clique tentaria abrir o seletor de arquivos do sistema (bloqueado para não travar). Use browser_upload com o caminho do arquivo no <input type=file> correspondente."; try { document.documentElement.removeAttribute("data-cm-fileblocked"); } catch (_) {} }
          const errs = detectErrors(); if (errs.length) r.errors = errs;
          return r;
        }
        if (op === "fill" || op === "fill_secret") {
          await settleSpinner();
          const el = await waitVisible(p); if (!el) return { ok: false, error: "campo não encontrado" };
          cursorLabel(op === "fill_secret" ? "Preenchendo •••" : "Preenchendo"); await moveTo(el); if (p.clearFirst) setVal(el, ""); setVal(el, p.value != null ? p.value : ""); cursorLabel("");
          const expected = p.value != null ? String(p.value) : "";
          const verified = op === "fill_secret" ? (String(el.value || "").length === expected.length) : (String(el.value || "") === expected);
          const r = { ok: true, filled: true, verified };
          const errs = detectErrors(); if (errs.length) r.errors = errs;
          return r;
        }
        if (op === "type") {
          const el = (p.selector || p.ref) ? await waitVisible(p) : document.activeElement; if (!el) return { ok: false, error: "sem elemento focado" };
          cursorLabel("Digitando"); el.focus(); for (const ch of String(p.text || "")) { setVal(el, (el.value || "") + ch); await sleep(12); } cursorLabel(""); return { ok: true };
        }
        if (op === "press") {
          const el = document.activeElement || document.body; const key = p.key;
          for (const t of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(t, { key, bubbles: true }));
          if (key === "Enter") { const f = el.closest && el.closest("form"); if (f) { f.requestSubmit ? f.requestSubmit() : f.submit(); } }
          return { ok: true };
        }
        if (op === "hover") {
          const el = await waitVisible(p); if (!el) return { ok: false, error: "não encontrado" };
          cursorLabel("Passando o mouse"); const c = await moveTo(el); ["mouseover", "mouseenter", "mousemove"].forEach((t) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: c.x, clientY: c.y }))); cursorLabel(""); return { ok: true };
        }
        if (op === "move_cursor") {
          if (p.selector || p.ref) { const el = await waitVisible(p); if (!el) return { ok: false, error: "não encontrado" }; const c = await moveTo(el); return { ok: true, x: c.x, y: c.y }; }
          if (p.x != null && p.y != null) { const cur = ensureCursor(); cur.style.transform = "translate(" + p.x + "px," + p.y + "px)"; await sleep(470); return { ok: true, x: p.x, y: p.y }; }
          return { ok: false, error: "faltou selector/ref ou x,y" };
        }
        if (op === "drag") {
          const src = resolveEl(p); if (!src) return { ok: false, error: "origem não encontrada" };
          const tgt = (p.toSelector || p.toRef) ? resolveEl({ selector: p.toSelector, ref: p.toRef }) : null;
          const sr = src.getBoundingClientRect();
          const sx = sr.left + sr.width / 2, sy = sr.top + sr.height / 2;
          let tx = p.toX, ty = p.toY;
          if (tgt) { const tr = tgt.getBoundingClientRect(); tx = tr.left + tr.width / 2; ty = tr.top + tr.height / 2; }
          if (tx == null || ty == null) return { ok: false, error: "destino não encontrado" };
          const dt = new DataTransfer();
          const fire = (el, type, x, y) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
          cursorLabel("Arrastando"); await moveTo(src);
          fire(src, "dragstart", sx, sy);
          const overEl = tgt || document.elementFromPoint(tx, ty) || src;
          const cur = ensureCursor(); cur.style.transform = "translate(" + tx + "px," + ty + "px)"; await sleep(320);
          fire(overEl, "dragenter", tx, ty); fire(overEl, "dragover", tx, ty); await sleep(90);
          fire(overEl, "drop", tx, ty); fire(src, "dragend", tx, ty);
          cursorLabel(""); return { ok: true, dragged: true };
        }
        if (op === "scroll") {
          if (p.selector || p.ref) { const el = resolveEl(p); if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); }
          else if (p.to === "top") window.scrollTo({ top: 0, behavior: "smooth" });
          else if (p.to === "bottom") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
          else window.scrollBy({ top: p.deltaY || 500, behavior: "smooth" });
          await sleep(280); return { ok: true, scrollY: window.scrollY };
        }
        if (op === "select") {
          const el = resolveEl(p); if (!el || el.tagName !== "SELECT") return { ok: false, error: "select não encontrado" };
          let opt = null; if (p.value != null) opt = [...el.options].find((o) => o.value === p.value); if (!opt && p.label) opt = [...el.options].find((o) => (o.textContent || "").trim() === p.label);
          if (!opt) return { ok: false, error: "opção não encontrada" };
          el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); return { ok: true, selected: opt.value, verified: el.value === opt.value };
        }
        if (op === "submit") {
          const base = (p.selector || p.ref) ? resolveEl(p) : document.querySelector("form");
          const form = base && (base.tagName === "FORM" ? base : base.closest("form")); if (!form) return { ok: false, error: "form não encontrado" };
          const before = location.href;
          form.requestSubmit ? form.requestSubmit() : form.submit();
          await sleep(400);
          const r = { ok: true, submitted: true, navigated: location.href !== before };
          const errs = detectErrors(); if (errs.length) r.errors = errs;
          return r;
        }
        if (op === "query") {
          let els; try { els = [...document.querySelectorAll(p.selector)]; } catch (_) { return { ok: false, error: "seletor inválido" }; }
          els = els.slice(0, p.limit || 30);
          return { ok: true, count: els.length, elements: els.map((e) => { const r = e.getBoundingClientRect(); const attrs = {}; for (const at of e.attributes) attrs[at.name] = at.value; return { tag: e.tagName.toLowerCase(), text: (e.textContent || "").trim().slice(0, 200), value: e.value, visible: visible(e), disabled: !!e.disabled, bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, attrs }; }) };
        }
        if (op === "snapshot") {
          document.querySelectorAll("[data-cm-ref]").forEach((e) => e.removeAttribute("data-cm-ref"));
          const sel = "a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[onclick],[tabindex]";
          const els = [...document.querySelectorAll(sel)].filter(visible).slice(0, 120);
          let i = 0; const out = els.map((e) => { const ref = "r" + (++i); e.setAttribute("data-cm-ref", ref); const r = e.getBoundingClientRect(); const label = (e.getAttribute("aria-label") || e.placeholder || (e.type === "password" ? "" : e.value) || (e.textContent || "").trim() || e.name || "").trim().slice(0, 70); const role = e.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: (e.type || "text"), SELECT: "select", TEXTAREA: "textbox" }[e.tagName] || e.tagName.toLowerCase()); return { ref, role, label, x: Math.round(r.x), y: Math.round(r.y) }; });
          return { ok: true, url: location.href, title: document.title, elements: out };
        }
        if (op === "get_state") {
          const s = { ok: true, url: location.href, title: document.title, readyState: document.readyState, viewport: { w: innerWidth, h: innerHeight }, modalOpen: !!topModal(), spinner: !!findSpinner() };
          if (p.includeStorage) { s.cookies = document.cookie.slice(0, 800); try { s.localStorageKeys = Object.keys(localStorage).slice(0, 60); } catch (_) {} }
          return s;
        }
        if (op === "wait") {
          const t0 = Date.now(), to = p.timeoutMs || 8000, hasCond = !!(p.urlContains || p.selector || p.ref);
          while (Date.now() - t0 < to) {
            if (p.urlContains && location.href.includes(p.urlContains)) return { ok: true, matched: "url" };
            if (p.selector || p.ref) { const el = resolveEl(p); const vis = el && visible(el); if ((p.state === "hidden" && !vis) || ((!p.state || p.state === "visible") && vis)) return { ok: true, matched: "selector" }; }
            if (!hasCond) break;
            await sleep(150);
          }
          return { ok: !hasCond, timedOut: hasCond };
        }
        if (op === "read") {
          const f = p.format || "text";
          if (f === "html") return { ok: true, text: document.documentElement.outerHTML.slice(0, p.maxChars || 200000) };
          if (f === "a11y" || f === "markdown") {
            const sel = "h1,h2,h3,a[href],button,input,select,textarea,[role]";
            const els = [...document.querySelectorAll(sel)].filter(visible).slice(0, 200);
            const lines = els.map((e) => { const tag = e.tagName.toLowerCase(); const role = e.getAttribute("role") || (tag === "a" ? "link" : tag === "button" ? "button" : tag[0] === "h" ? "heading" : tag); const label = (e.getAttribute("aria-label") || e.placeholder || e.value || (e.textContent || "").trim() || "").slice(0, 90); return "- " + role + (label ? ": " + label : ""); });
            return { ok: true, text: document.title + "\n" + lines.join("\n") };
          }
          let text = document.body ? document.body.innerText : "";
          const max = p.maxChars || 40000; if (text.length > max) text = text.slice(0, max) + "\n…(truncado)";
          return { ok: true, text };
        }
        if (op === "login") {
          const pass = document.querySelector('input[type="password"]:not([disabled])');
          if (!pass) return { ok: false, error: "campo de senha não encontrado — a aba está na tela de login?" };
          cursorLabel("Entrando");
          const form = pass.closest("form"), scope = form || document;
          const cands = [...scope.querySelectorAll('input[type="email"],input[type="text"],input[type="tel"],input:not([type])')].filter((i) => i !== pass && visible(i));
          const user = cands.find((i) => /user|email|login|mail|cpf|phone|usuario/i.test((i.name || "") + (i.id || "") + (i.autocomplete || "") + (i.getAttribute("aria-label") || ""))) || cands[cands.length - 1] || cands[0];
          if (user && p.username) { await moveTo(user); setVal(user, p.username); await sleep(140); }
          await moveTo(pass); setVal(pass, p.password || ""); await sleep(140);
          const beforeUrl = location.href; let submitted = false;
          if (p.submit !== false) {
            const btn = scope.querySelector('button[type="submit"],input[type="submit"]') || [...scope.querySelectorAll("button")].find((b) => /entrar|login|sign\s?in|acessar|log\s?in|continuar|enviar|submit/i.test(b.textContent || ""));
            if (btn) { const c = await moveTo(btn); ripple(c.x, c.y); await sleep(100); btn.click(); submitted = true; }
            else if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); submitted = true; }
          }
          cursorLabel(""); return { ok: true, submitted, filledUser: !!user, beforeUrl };
        }
        if (op === "mark" || op === "unmark") {
          // Set-of-marks: desenha números nos elementos interativos e devolve o mapa
          // número→ref. Os badges aparecem na screenshot (o modelo vê) E na tela (você vê).
          const CMK = "__claudao_marks__";
          const old = document.getElementById(CMK); if (old) old.remove();
          // limpa refs obsoletos de marcações anteriores (evita ref antigo colar em elemento errado)
          document.querySelectorAll("[data-cm-ref]").forEach((e) => e.removeAttribute("data-cm-ref"));
          if (op === "unmark") return { ok: true, unmarked: true };
          const box = document.createElement("div"); box.id = CMK;
          box.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
          document.documentElement.appendChild(box);
          const sel = "a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=switch],[role=radio],[onclick],[contenteditable=true],[tabindex]";
          // só elementos DENTRO da dobra (o badge é fixed no viewport e a foto do look é do viewport)
          const inVp = (e) => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
          const seen = new Set();
          const els = [...document.querySelectorAll(sel)].filter((e) => visible(e) && inVp(e) && !seen.has(e) && seen.add(e)).slice(0, p.limit || 100);
          let i = 0; const out = [];
          for (const e of els) {
            const ref = "r" + (++i); e.setAttribute("data-cm-ref", ref);
            const r = e.getBoundingClientRect();
            const val = e.type === "password" ? "" : e.value; // nunca expor senha no rótulo
            const label = (e.getAttribute("aria-label") || e.placeholder || val || (e.textContent || "").trim() || e.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
            const role = e.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: (e.type || "text"), SELECT: "select", TEXTAREA: "textbox" }[e.tagName] || e.tagName.toLowerCase());
            const ol = document.createElement("div");
            ol.style.cssText = "position:fixed;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px;border:1.5px solid rgba(255,59,59,.55);border-radius:3px;box-sizing:border-box;pointer-events:none;";
            const badge = document.createElement("div"); badge.textContent = i;
            badge.style.cssText = "position:fixed;left:" + Math.max(0, r.left) + "px;top:" + Math.max(0, r.top) + "px;transform:translate(-1px,-1px);background:#ff3b3b;color:#fff;font:700 11px/1.35 system-ui,sans-serif;padding:0 4px;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.5);pointer-events:none;";
            box.appendChild(ol); box.appendChild(badge);
            out.push({ ref, mark: i, role, label, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
          }
          return { ok: true, url: location.href, title: document.title, count: out.length, elements: out, modalOpen: !!topModal(), spinner: !!findSpinner() };
        }
        if (op === "inspect") {
          const el = resolveEl(p); if (!el) return { ok: false, error: "elemento não encontrado" };
          flash(el);
          const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
          const attrs = {}; for (const at of el.attributes) attrs[at.name] = at.value;
          const styles = {}; for (const k of ["display", "position", "color", "backgroundColor", "fontSize", "fontWeight", "zIndex", "opacity", "visibility", "border", "margin", "padding", "width", "height", "overflow"]) styles[k] = cs[k];
          return { ok: true, tag: el.tagName.toLowerCase(), text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300), value: el.value, visible: visible(el), disabled: !!el.disabled,
            bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, attrs, styles,
            a11y: { role: el.getAttribute("role") || null, ariaLabel: el.getAttribute("aria-label") || null, name: el.getAttribute("name") || null, tabindex: el.getAttribute("tabindex") || null },
            html: el.outerHTML.slice(0, 900) };
        }
        if (op === "observe") {
          // Diff de DOM: só o que mudou desde a última observação (loop de ajuste ágil).
          const KEY = "__claudaoObs";
          if (p.stop) { try { if (window[KEY] && window[KEY].mo) window[KEY].mo.disconnect(); } catch (_) {} window[KEY] = null; return { ok: true, stopped: true }; }
          if (p.reset || !window[KEY]) {
            try { if (window[KEY] && window[KEY].mo) window[KEY].mo.disconnect(); } catch (_) {}
            const state = { changes: [] };
            const own = (n) => !!(n && n.nodeType === 1 && ((n.id && String(n.id).indexOf("__claudao") === 0) || (n.closest && n.closest("#__claudao_marks__,#__claudao_glow__,#__claudao_cursor__"))));
            const mo = new MutationObserver((muts) => {
              for (const m of muts) {
                if (m.type === "attributes" && m.attributeName === "data-cm-ref") continue; // ruído da própria extensão
                if (own(m.target)) continue;
                if (m.type === "childList") {
                  for (const n of m.addedNodes) if (n.nodeType === 1 && !own(n)) state.changes.push({ t: "add", tag: n.tagName.toLowerCase(), text: (n.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) });
                  for (const n of m.removedNodes) if (n.nodeType === 1 && !own(n)) state.changes.push({ t: "remove", tag: n.tagName.toLowerCase(), text: (n.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) });
                } else if (m.type === "attributes") { state.changes.push({ t: "attr", tag: m.target.tagName && m.target.tagName.toLowerCase(), attr: m.attributeName }); }
                else if (m.type === "characterData") { state.changes.push({ t: "text", text: (m.target.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) }); }
                if (state.changes.length > 800) state.changes.shift();
              }
            });
            try { mo.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true }); } catch (_) {}
            state.mo = mo; window[KEY] = state;
            return { ok: true, started: true, changes: [], count: 0 };
          }
          const st = window[KEY]; const lim = p.limit || 120;
          const out = st.changes.slice(-lim); // as MAIS NOVAS
          const dropped = Math.max(0, st.changes.length - out.length);
          st.changes = [];
          return { ok: true, changes: out, count: out.length, dropped };
        }
        return { ok: false, error: "op desconhecida: " + op };
      } catch (e) { try { cursorLabel(""); } catch (_) {} return { ok: false, error: String((e && e.message) || e) }; }
    })();
  }

  async function agentExec(tabId, payload) {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: agentDispatch, args: [payload] });
    return r ? r.result : { ok: false, error: "sem resposta da página" };
  }

  // Upload de arquivo(s) num <input type=file> via CDP (caminhos locais).
  async function uploadFiles(tabId, selector, files) {
    return withDebugger(tabId, async (target) => {
      const { root } = await chrome.debugger.sendCommand(target, "DOM.getDocument", { depth: -1, pierce: true });
      let nodeId = 0;
      const q = async (sel) => { try { return (await chrome.debugger.sendCommand(target, "DOM.querySelector", { nodeId: root.nodeId, selector: sel })).nodeId || 0; } catch (_) { return 0; } };
      if (selector) nodeId = await q(selector);
      if (!nodeId) nodeId = await q('input[type=file]');       // fallback: primeiro input de arquivo (id dinâmico etc.)
      if (!nodeId) { try { const all = await chrome.debugger.sendCommand(target, "DOM.querySelectorAll", { nodeId: root.nodeId, selector: 'input[type=file]' }); if (all && all.nodeIds && all.nodeIds.length) nodeId = all.nodeIds[0]; } catch (_) {} }
      if (!nodeId) return { ok: false, error: "nenhum <input type=file> encontrado" + (selector ? " (nem por '" + selector + "' nem o primeiro da página)" : "") + ". Dica: em alguns sites o input fica oculto atrás do botão de 'carregar'." };
      await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", { files, nodeId });
      return { ok: true, uploaded: files.length };
    });
  }

  // Clique com eventos REAIS de mouse (CDP Input) — para sites que rejeitam
  // eventos sintéticos (isTrusted). Mostra a barra de depuração enquanto ativo.
  async function realClick(tabId, a) {
    const [b] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, ref, text) => {
        let el = null;
        if (ref) el = document.querySelector('[data-cm-ref="' + ref + '"]');
        else if (sel) el = document.querySelector(sel);
        else if (text) { const tt = String(text).toLowerCase(); el = [...document.querySelectorAll("a,button,[role=button],input[type=submit],input[type=button]")].find((e) => ((e.textContent || e.value || "") + "").toLowerCase().includes(tt)); }
        if (!el) return null;
        if (el.tagName === "INPUT" && el.type === "file") return { fileInput: true };
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      },
      args: [a.selector || "", a.ref || "", a.text || ""],
    });
    if (!b || !b.result) return { ok: false, error: "elemento não encontrado" };
    if (b.result.fileInput) return { ok: false, error: "Este é um <input type=file>: use browser_upload com o caminho do arquivo, não clique." };
    const x = Math.round(b.result.x), y = Math.round(b.result.y);
    return withDebugger(tabId, async (target) => {
      const base = { x, y, button: "left", clickCount: 1 };
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
      return { ok: true, clicked: true, real: true };
    });
  }

  async function exec(msg, tabId, host) {
    const a = msg.args || {};
    switch (msg.cmd) {
      case "tabs": {
        const tabs = await chrome.tabs.query({});
        return { ok: true, result: tabs.filter((t) => /^https?:/.test(t.url || "")).map((t) => ({ tabId: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })) };
      }
      // --- Percepção (via agente de página) ---
      case "read": { const r = await agentExec(tabId, { op: "read", format: a.format, maxChars: a.maxChars }); return r.ok ? { ok: true, result: r.text } : { ok: false, error: r.error }; }
      case "query": { const r = await agentExec(tabId, { op: "query", selector: a.selector, limit: a.limit }); return r.ok ? { ok: true, result: { count: r.count, elements: r.elements } } : { ok: false, error: r.error }; }
      case "snapshot": { const r = await agentExec(tabId, { op: "snapshot" }); return r.ok ? { ok: true, result: { url: r.url, title: r.title, elements: r.elements } } : { ok: false, error: r.error }; }
      case "get_state": { const r = await agentExec(tabId, { op: "get_state", includeStorage: a.includeStorage }); return r.ok ? { ok: true, result: r } : { ok: false, error: r.error }; }
      case "wait": { const r = await agentExec(tabId, { op: "wait", selector: a.selector, ref: a.ref, state: a.state, urlContains: a.urlContains, timeoutMs: a.timeoutMs }); return { ok: true, result: r }; }
      case "console": {
        const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: (n, lvl) => (window.__claudaoLogs || []).filter((e) => !lvl || e.level === lvl).slice(-n), args: [a.limit || 200, a.level || ""] });
        return { ok: true, result: r ? r.result : [] };
      }
      case "network": {
        const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: (n, f) => (window.__claudaoNet || []).filter((e) => !f || (e.url || "").includes(f)).slice(-n), args: [a.limit || 60, a.filter || ""] });
        return { ok: true, result: r ? r.result : [] };
      }
      case "eval": { if (!a.code) throw new Error("faltou 'code'"); return { ok: true, result: await evalInTab(tabId, a.code) }; }
      case "screenshot": { return { ok: true, result: await screenshotTab(tabId, { fullPage: a.fullPage, selector: a.selector, maxWidth: a.maxWidth, format: a.format, quality: a.quality, redactPII: a.redactPII }) }; }
      case "look": {
        // Set-of-marks: marca os elementos, tira a foto (leve) com os números, devolve foto + mapa.
        const map = await agentExec(tabId, { op: "mark", limit: a.limit });
        if (!map || !map.ok) return { ok: false, error: (map && map.error) || "falha ao marcar" };
        await new Promise((r) => setTimeout(r, 160)); // deixa os badges pintarem antes da captura
        const shot = await screenshotTab(tabId, { maxWidth: a.maxWidth, format: a.format || "jpeg", quality: a.quality, redactPII: a.redactPII });
        setTimeout(() => { agentExec(tabId, { op: "unmark" }).catch(() => {}); }, a.keepMarks ? 4000 : 900);
        return { ok: true, result: { look: true, url: map.url, title: map.title, dataUrl: shot.dataUrl, mime: shot.mime, width: shot.width, height: shot.height, count: map.count, elements: map.elements, modalOpen: map.modalOpen, spinner: map.spinner } };
      }
      case "mark": { const r = await agentExec(tabId, { op: a.clear ? "unmark" : "mark", limit: a.limit }); return r.ok ? { ok: true, result: r } : { ok: false, error: r.error }; }
      case "inspect": { const r = await agentExec(tabId, { op: "inspect", selector: a.selector, ref: a.ref, text: a.text }); return r.ok ? { ok: true, result: r } : { ok: false, error: r.error }; }
      case "observe": { const r = await agentExec(tabId, { op: "observe", reset: a.reset, limit: a.limit }); return r.ok ? { ok: true, result: r } : { ok: false, error: r.error }; }

      // --- Ação (via agente de página, com cursor) ---
      case "click": {
        if (a.real) { const r = await realClick(tabId, a); return r.ok ? { ok: true, result: r } : { ok: false, error: r.error }; }
        const r = await agentExec(tabId, { op: "click", selector: a.selector, ref: a.ref, text: a.text, timeoutMs: a.timeoutMs }); return r.ok ? { ok: true, result: r } : { ok: false, error: r.error };
      }
      case "fill": { const r = await agentExec(tabId, { op: "fill", selector: a.selector, ref: a.ref, value: a.value, clearFirst: a.clearFirst }); return r.ok ? { ok: true, result: r } : { ok: false, error: r.error }; }
      case "type": { const r = await agentExec(tabId, { op: "type", selector: a.selector, ref: a.ref, text: a.text }); return r.ok ? { ok: true, result: r } : { ok: false, error: r.error }; }
      case "press": { const r = await agentExec(tabId, { op: "press", key: a.key }); return { ok: true, result: r }; }
      case "hover": { const r = await agentExec(tabId, { op: "hover", selector: a.selector, ref: a.ref }); return r.ok ? { ok: true, result: r } : { ok: false, error: r.error }; }
      case "scroll": { const r = await agentExec(tabId, { op: "scroll", selector: a.selector, ref: a.ref, deltaY: a.deltaY, to: a.to }); return { ok: true, result: r }; }
      case "select": { const r = await agentExec(tabId, { op: "select", selector: a.selector, ref: a.ref, value: a.value, label: a.label }); return r.ok ? { ok: true, result: r } : { ok: false, error: r.error }; }
      case "submit": { const r = await agentExec(tabId, { op: "submit", selector: a.selector, ref: a.ref }); return r.ok ? { ok: true, result: r } : { ok: false, error: r.error }; }
      case "navigate": {
        if (!a.url) throw new Error("faltou 'url'");
        // Abre em NOVA aba (preserva a página de trabalho) quando pedido ou quando
        // é recurso/arquivo local. Devolve o tabId novo p/ o modelo agir nele.
        if (navOpensNewTab(a.url, a.newTab)) {
          const tab = await chrome.tabs.create({ url: a.url, active: a.active !== false });
          return { ok: true, result: { openedNewTab: true, tabId: tab.id, url: a.url, keptWorkingTab: tabId || null } };
        }
        await chrome.tabs.update(tabId, { url: a.url });
        return { ok: true, result: { navigated: true, url: a.url } };
      }
      case "history": {
        if (a.action === "back") { try { await chrome.tabs.goBack(tabId); } catch (_) {} }
        else if (a.action === "forward") { try { await chrome.tabs.goForward(tabId); } catch (_) {} }
        else await chrome.tabs.reload(tabId, { bypassCache: !!a.hard }); // hard = ignora cache (Ctrl+Shift+R)
        return { ok: true, result: { action: a.action, hard: !!a.hard } };
      }
      case "reload_extension": {
        if (!(await getAllowExtReload())) return { ok: false, error: "Recarregar a extensão está desativado. Ligue 'Permitir recarregar a extensão' no painel do Claudão² (tomada → Segurança)." };
        // Agenda o reload para DEPOIS de enviar esta resposta (o reload derruba o SW).
        setTimeout(() => { try { chrome.runtime.reload(); } catch (_) {} }, 500);
        return { ok: true, result: { reloading: true, note: "Extensão recarregando (relê o código do disco em modo descompactado). A ponte reconecta sozinha em segundos; abas do claude.ai já abertas podem precisar de refresh para a UI nova. Não recarrega o mcp-server do editor." } };
      }
      case "move_cursor": { const r = await agentExec(tabId, { op: "move_cursor", selector: a.selector, ref: a.ref, x: a.x, y: a.y }); return r.ok ? { ok: true, result: r } : { ok: false, error: r.error }; }
      case "drag": { const r = await agentExec(tabId, { op: "drag", selector: a.selector, ref: a.ref, toSelector: a.toSelector, toRef: a.toRef, toX: a.toX, toY: a.toY }); return r.ok ? { ok: true, result: r } : { ok: false, error: r.error }; }
      case "upload": {
        if (!a.selector) throw new Error("faltou 'selector'");
        const files = Array.isArray(a.files) ? a.files : (a.path ? [a.path] : []);
        if (!files.length) throw new Error("faltou 'files' (lista de caminhos) ou 'path'");
        const r = await uploadFiles(tabId, a.selector, files);
        return r.ok ? { ok: true, result: r } : { ok: false, error: r.error };
      }

      // --- Multi-aba ---
      case "open_tab": { const tab = await chrome.tabs.create({ url: a.url, active: a.active !== false }); return { ok: true, result: { tabId: tab.id, url: a.url } }; }
      case "close_tab": { if (!a.tabId) throw new Error("faltou 'tabId'"); await chrome.tabs.remove(a.tabId); return { ok: true, result: { closed: a.tabId } }; }
      case "activate_tab": {
        if (!a.tabId) throw new Error("faltou 'tabId'");
        const tb = await chrome.tabs.update(a.tabId, { active: true });
        try { if (tb && tb.windowId != null) await chrome.windows.update(tb.windowId, { focused: true }); } catch (_) {}
        return { ok: true, result: { activated: a.tabId } };
      }

      // --- Login seguro e frictionless ---
      case "login": {
        let username = a.username, password = a.password;
        if (a.credentialRef) { // resolve do cofre local (o modelo nunca vê o valor)
          const c = await resolveCredential(a.credentialRef, host);
          if (!c) return { ok: false, error: "credencial '" + a.credentialRef + "' não encontrada no cofre" };
          if (!username) username = c.username;
          password = c.value;
        }
        addSecret(password); // redige em retornos posteriores; nunca ecoa/loga
        const r = await agentExec(tabId, { op: "login", username, password, submit: a.submit });
        if (!r || !r.ok) return { ok: false, error: (r && r.error) || "falha no login" };
        let loggedIn = false, url = r.beforeUrl;
        if (r.submitted) {
          for (let i = 0; i < 27; i++) { // espera pós-login no SW (sobrevive à navegação) ~8s
            await new Promise((res) => setTimeout(res, 300));
            try {
              const [s] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ url: location.href, hasPass: !!document.querySelector('input[type="password"]') }) });
              if (s && s.result) { url = s.result.url; if (url !== r.beforeUrl || !s.result.hasPass) { loggedIn = true; break; } }
            } catch (_) {}
          }
        }
        return { ok: true, result: { loggedIn, url, filledUser: r.filledUser, submitted: r.submitted } };
      }
      case "fill_secret": {
        let value = a.value;
        if (a.credentialRef) {
          const c = await resolveCredential(a.credentialRef, host);
          if (!c) return { ok: false, error: "credencial '" + a.credentialRef + "' não encontrada no cofre" };
          value = c.value;
        }
        if (value != null) addSecret(value);
        const r = await agentExec(tabId, { op: "fill", selector: a.selector, ref: a.ref, value });
        return r.ok ? { ok: true, result: { filled: true } } : { ok: false, error: r.error };
      }

      // --- Cofre de credenciais (valores nunca voltam ao modelo) ---
      case "credentials_list": {
        const items = await vaultItems();
        return { ok: true, result: items.map((it) => ({ name: it.name, domain: it.domain, username: it.username || "" })) };
      }
      case "credentials_save": {
        if (!a.name || a.value == null) throw new Error("faltou 'name'/'value'");
        addSecret(a.value);
        return { ok: true, result: await vaultSave({ domain: a.domain || host || "", name: a.name, username: a.username, value: a.value }) };
      }
      case "credentials_delete": {
        if (!a.name) throw new Error("faltou 'name'");
        return { ok: true, result: await vaultDelete(a.name, a.domain) };
      }

      // --- Handoff: passa a tarefa para o Claude nativo do navegador (ou lê a resposta) ---
      case "handoff": {
        if (a.read) {
          let hf = null; try { hf = (await chrome.storage.local.get(HANDOFF_KEY))[HANDOFF_KEY]; } catch (_) {}
          return { ok: true, result: hf || { message: null, reply: null } };
        }
        if (!a.message) throw new Error("faltou 'message' (o que o Claude do navegador deve continuar)");
        await chrome.storage.local.set({ [HANDOFF_KEY]: { from: msg.client || "Claude externo", message: String(a.message).slice(0, 2000), task: a.task || null, ts: Date.now(), seen: false, dismissed: false, reply: null } });
        return { ok: true, result: { delivered: true, note: "Tarefa entregue ao Claude do navegador. Use handoff {read:true} depois para ver a resposta dele." } };
      }

      // --- Memória (Claude externo lê/escreve a memória do Claudão²) ---
      case "memory_list": {
        if (!MEM) throw new Error("memória indisponível");
        const docs = await MEM.getDocs();
        return { ok: true, result: docs.map((d) => ({ name: d.name, pinned: !!d.pinned, chars: (d.content || "").length })) };
      }
      case "memory_read": {
        if (!MEM) throw new Error("memória indisponível");
        if (!a.name) throw new Error("faltou 'name'");
        const d = await MEM.getDoc(a.name);
        return { ok: true, result: d ? d.content : null };
      }
      case "memory_search": {
        if (!MEM) throw new Error("memória indisponível");
        if (!a.query) throw new Error("faltou 'query'");
        const r = await MEM.retrieve(a.query, {});
        return { ok: true, result: r.map((x) => ({ doc: x.doc, heading: x.heading, text: x.text })) };
      }
      case "memory_append": {
        if (!MEM) throw new Error("memória indisponível");
        if (!a.text) throw new Error("faltou 'text'");
        const r = await MEM.capture(a.text, a.file || "");
        return { ok: true, result: r || { skipped: true } };
      }
      case "memory_write": {
        if (!MEM) throw new Error("memória indisponível");
        if (!a.name || a.content == null) throw new Error("faltou 'name'/'content'");
        await MEM.upsertDoc(a.name, a.content, a.pinned);
        return { ok: true, result: { written: a.name } };
      }
      case "memory_delete": {
        if (!MEM) throw new Error("memória indisponível");
        if (!a.name) throw new Error("faltou 'name'");
        await MEM.deleteDoc(a.name);
        return { ok: true, result: { deleted: a.name } };
      }

      default:
        return { ok: false, error: "comando desconhecido: " + msg.cmd };
    }
  }

  // Hook de teste (só quando __CM_TEST) — expõe a lógica pura de segurança/cofre.
  if (globalThis.__CM_TEST) {
    globalThis.__cmBridgeTest = { hostOf, hostMatches, hostAllowed, getAllowlist, resolveCredential, vaultSave, vaultDelete, vaultItems, summarizeArgs, sessionConsent, ACTION_CMDS, encSecret, decSecret, withTabLock, navOpensNewTab };
  }
})();
