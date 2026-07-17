/*
 * Claudão² Bridge — captura de console (content script, mundo MAIN).
 * Guarda console.log/warn/error/info/debug + erros + rejeições em
 * window.__claudaoLogs, lido pela ferramenta browser_console.
 * Roda em document_start para pegar tudo desde o carregamento.
 */
(function () {
  if (window.__claudaoLogsInstalled) return;
  window.__claudaoLogsInstalled = true;
  const buf = (window.__claudaoLogs = window.__claudaoLogs || []);
  const push = (level, parts) => {
    try {
      const msg = parts
        .map((x) => {
          if (typeof x === "string") return x;
          try { return JSON.stringify(x); } catch { return String(x); }
        })
        .join(" ");
      buf.push({ level, t: Date.now(), msg });
      if (buf.length > 500) buf.shift();
    } catch (_) {}
  };
  // Captura só log/info/debug embrulhando o console. NÃO embrulhamos warn/error DE PROPÓSITO:
  // este script roda no mundo MAIN, então re-emitir um console.warn/error DA PÁGINA a partir do
  // nosso frame faz o Chrome atribuir o aviso À EXTENSÃO — ele aparece em chrome://extensions >
  // Erros, poluindo com avisos que são da página (ex.: "VIDEOJS: WARN" do LinkedIn), não bugs
  // nossos. Os erros que IMPORTAM (exceções não capturadas e rejeições) continuam registrados pelos
  // listeners abaixo, que não passam pelo console e não poluem. (log/info/debug não são coletados
  // pelo Chrome como erro, então embrulhá-los é seguro.)
  ["log", "info", "debug"].forEach((level) => {
    const orig = console[level];
    console[level] = function () {
      push(level, Array.prototype.slice.call(arguments));
      return orig.apply(this, arguments);
    };
  });
  window.addEventListener("error", (e) => {
    push("error", [(e.message || "erro") + " @ " + (e.filename || "") + ":" + (e.lineno || "")]);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    push("error", ["unhandledrejection: " + ((r && (r.message || r.stack)) || r)]);
  });

  // --- Memória INVISÍVEL nas abas do claude.ai ---
  // O painel injeta o bloco de memória no `system` do POST /v1/messages (invisível). Nas abas
  // claude.ai o content script roda em mundo ISOLADO e NÃO alcança o window.fetch da página, então
  // a memória caía no CAMPO DE MENSAGEM (visível). Aqui (mundo MAIN) fazemos a injeção no `system`,
  // como o painel. Este mundo NÃO acessa chrome.storage: o bloco é computado no mundo isolado
  // (inject.js) e entregue por postMessage. Gated em claude.ai (o script roda em <all_urls>; sem
  // isso, memória vazaria em qualquer site que POSTasse pra uma URL /v1/messages).
  const CM_ON_CLAUDE = /(^|\.)claude\.ai$/i.test(location.hostname);
  const CM_MEM_TAG = "=== MEMÓRIA PERSISTENTE DO CLAUDE";
  // LIMITAÇÃO CONHECIDA: MAIN e ISOLADO só se falam pelo DOM compartilhado (postMessage) — qualquer
  // código in-page (a própria claude.ai, outra extensão em mundo MAIN, ou um XSS na claude.ai) pode
  // observar o bloco. É inerente a qualquer canal MAIN↔isolado; o risco é baixo (essas ameaças já
  // leem tudo que o usuário digita/vê na claude.ai) e é melhor que o estado anterior (texto visível
  // no campo de mensagem). O `system` já leva esse bloco pro backend de qualquer forma.
  let cmMemSeq = 0; const cmMemPending = new Map();
  let cmResponderReady = false; // o mundo isolado anuncia "ready" ao instalar o responder
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__cmMem == null) return;
    if (d.__cmMem === "ready") { cmResponderReady = true; return; }
    if (d.__cmMem === "block" && cmMemPending.has(d.id)) { const r = cmMemPending.get(d.id); cmMemPending.delete(d.id); r(d.block || ""); }
  });
  function cmRequestMemBlock(query) {
    return new Promise((resolve) => {
      const id = ++cmMemSeq; cmMemPending.set(id, resolve);
      try { window.postMessage({ __cmMem: "need", id, query: query || "" }, location.origin); }
      catch (_) { cmMemPending.delete(id); return resolve(""); }
      setTimeout(() => { if (cmMemPending.has(id)) { cmMemPending.delete(id); resolve(""); } }, 800); // fallback: nunca trava o envio
    });
  }
  function cmLastUserText(p) {
    try { const msgs = p.messages || [];
      for (let i = msgs.length - 1; i >= 0; i--) { const m = msgs[i]; if (m.role !== "user") continue;
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) return m.content.filter((b) => b && (b.type === "text" || typeof b.text === "string")).map((b) => b.text || "").join(" "); }
    } catch (_) {} return "";
  }
  function cmIsUtility(p) { // pula geração de título (mesma heurística do painel)
    try { const all = (p.messages || []).map((m) => typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.map((b) => (b && b.text) || "").join(" ") : "")).join(" ");
      return /suggest a title based on|between <title> tags/i.test(all);
    } catch (_) { return false; }
  }
  async function cmInjectMemory(input, init) {
    if (!cmResponderReady) return [input, init]; // responder isolado ainda não carregou (ou inject.js abortou): pula NA HORA, sem pagar timeout
    let bodyText = null;
    if (init && typeof init.body === "string") bodyText = init.body;
    else if (typeof Request !== "undefined" && input instanceof Request) { try { bodyText = await input.clone().text(); } catch (_) {} }
    if (!bodyText) return [input, init];
    let p; try { p = JSON.parse(bodyText); } catch (_) { return [input, init]; }
    if (!p || !Array.isArray(p.messages) || cmIsUtility(p)) return [input, init];
    if (JSON.stringify(p.system || "").includes(CM_MEM_TAG)) return [input, init]; // já injetado (dedup)
    const block = await cmRequestMemBlock(cmLastUserText(p));
    if (!block) return [input, init];
    if (Array.isArray(p.system)) p.system.push({ type: "text", text: block });
    else if (typeof p.system === "string" && p.system) p.system = p.system + "\n\n" + block;
    else p.system = block;
    const newBody = JSON.stringify(p);
    if (init && typeof init.body === "string") return [input, Object.assign({}, init, { body: newBody })];
    return [new Request(input, { body: newBody, method: "POST" }), init];
  }

  // --- Captura de rede (fetch + XHR) para browser_network ---
  const net = (window.__claudaoNet = window.__claudaoNet || []);
  const rec = (o) => { net.push(o); if (net.length > 300) net.shift(); };
  try {
    const of = window.fetch;
    if (of && !of.__cmWrapped) {
      const wf = async function (input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const method = ((init && init.method) || (typeof input === "object" && input.method) || "GET").toUpperCase();
        if (CM_ON_CLAUDE && method === "POST" && /\/v1\/messages(?:\?|$)/.test(url)) {
          try { [input, init] = await cmInjectMemory(input, init); } catch (_) {}
        }
        const t0 = performance.now();
        return of.call(this, input, init).then(
          (res) => { rec({ type: "fetch", method, url, status: res.status, ms: Math.round(performance.now() - t0), t: Date.now() }); return res; },
          (err) => { rec({ type: "fetch", method, url, status: 0, error: String(err && err.message || err), ms: Math.round(performance.now() - t0), t: Date.now() }); throw err; }
        );
      };
      wf.__cmWrapped = true;
      window.fetch = wf;
    }
    const XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XP && !XP.__cmWrapped) {
      const oOpen = XP.open, oSend = XP.send;
      XP.open = function (m, u) { this.__cm = { method: (m || "GET").toUpperCase(), url: u, t0: performance.now() }; return oOpen.apply(this, arguments); };
      XP.send = function () {
        const c = this.__cm;
        if (c) this.addEventListener("loadend", () => rec({ type: "xhr", method: c.method, url: c.url, status: this.status, ms: Math.round(performance.now() - c.t0), t: Date.now() }));
        return oSend.apply(this, arguments);
      };
      XP.__cmWrapped = true;
    }
  } catch (_) {}

  // --- Anti-trava de upload ---
  // Enquanto o agente está ativo (o glow #__claudao_glow__ está na tela), NÃO deixa um
  // clique PROGRAMÁTICO abrir o seletor de arquivos do SO (diálogo modal que trava o
  // agente). O modelo deve usar browser_upload (caminho do arquivo). O bloqueio é
  // marcado num atributo do <html> para o agente (mundo isolado) avisar quem clicou.
  try {
    const IP = window.HTMLInputElement && window.HTMLInputElement.prototype;
    const agentActive = () => !!document.getElementById("__claudao_glow__");
    // Fonte de verdade de "é o Claude dirigindo AGORA": o SW carimba data-cm-driving no <html>
    // logo antes de cada clique (DOM ou CDP). O clique CDP é isTrusted e carrega user-activation,
    // então NÃO dá pra distinguir do usuário só pelo gesto — este marcador resolve.
    const claudeDriving = () => { try { const v = +document.documentElement.getAttribute("data-cm-driving"); return v && Date.now() < v; } catch (_) { return false; } };
    // Fallback: bloqueia também quando não há gesto algum (clique programático sem marcador).
    const noUserGesture = () => { try { return navigator.userActivation ? !navigator.userActivation.isActive : true; } catch (_) { return true; } };
    // Bloqueia se o agente está ativo E (o Claude está dirigindo OU não houve gesto real).
    // O upload MANUAL do usuário nunca seta data-cm-driving e carrega gesto → nunca é engolido.
    const suppress = () => agentActive() && (claudeDriving() || noUserGesture());
    const markBlocked = (el) => { try { document.documentElement.setAttribute("data-cm-fileblocked", JSON.stringify({ ts: Date.now(), name: (el && (el.name || el.id || el.getAttribute("aria-label"))) || "" })); } catch (_) {} };
    if (IP && !IP.__cmClickWrapped) {
      const oc = IP.click;
      IP.click = function () { if (this.type === "file" && suppress()) { markBlocked(this); return; } return oc.apply(this, arguments); };
      IP.__cmClickWrapped = true;
      if (IP.showPicker) { const op = IP.showPicker; IP.showPicker = function () { if (this.type === "file" && suppress()) { markBlocked(this); return; } return op.apply(this, arguments); }; }
    }
  } catch (_) {}
})();
