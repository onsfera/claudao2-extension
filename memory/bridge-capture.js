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
  ["log", "warn", "error", "info", "debug"].forEach((level) => {
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
})();
