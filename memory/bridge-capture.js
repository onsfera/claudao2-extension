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

  // --- Captura de rede (fetch + XHR) para browser_network ---
  const net = (window.__claudaoNet = window.__claudaoNet || []);
  const rec = (o) => { net.push(o); if (net.length > 300) net.shift(); };
  try {
    const of = window.fetch;
    if (of && !of.__cmWrapped) {
      const wf = function (input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const method = ((init && init.method) || (typeof input === "object" && input.method) || "GET").toUpperCase();
        const t0 = performance.now();
        return of.apply(this, arguments).then(
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
