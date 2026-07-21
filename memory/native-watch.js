/*
 * Claudão² — observador do agente NATIVO do painel.
 *
 * O nosso glow (borda + favicon + título) era disparado só pelos comandos que chegam da ponte MCP
 * (Claude externo). Quando o agente do PRÓPRIO painel age numa página, ele não passa pela ponte, então
 * nada acendia. O nativo avisa a aba por chrome.tabs.sendMessage (é assim que o indicador dele nasce);
 * aqui escutamos as MESMAS mensagens e repassamos ao nosso service worker, que já resolve a aba pelo
 * sender.tab.id — sem precisar replicar a lógica de "aba efetiva" do nativo.
 *
 * Cuidados:
 *  - NÃO chamamos sendResponse nem retornamos true: quem responde é o listener nativo.
 *  - HIDE_FOR_TOOL_USE/SHOW_AFTER_TOOL_USE são honrados: o nativo esconde os indicadores dele antes de
 *    clicar/capturar, e se o nosso ficasse visível entraria na screenshot que vai pro modelo.
 *  - Essas duas também servem de heartbeat: SHOW_AGENT_INDICATORS é evento de BORDA (não se repete a
 *    cada ação), e o nosso glow expira sozinho se não for renovado.
 *  - SHOW_STATIC_INDICATOR é ignorado de propósito: é aba secundária do grupo, onde o agente NÃO age.
 */
(() => {
  if (window.__claudaoNativeWatch) return;
  window.__claudaoNativeWatch = true;

  const send = (m) => {
    try { chrome.runtime.sendMessage(m, () => { void chrome.runtime.lastError; }); } catch (_) {}
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return; // sem sendResponse, sem return true
    switch (msg.type) {
      case "SHOW_AGENT_INDICATORS": send({ cm_native: "on" }); break;
      case "SHOW_AFTER_TOOL_USE":   send({ cm_native: "show" }); break; // volta a aparecer + renova o TTL
      case "HIDE_FOR_TOOL_USE":     send({ cm_native: "hide" }); break; // some da screenshot que vai pro modelo
      case "HIDE_AGENT_INDICATORS":
      case "HIDE_STATIC_INDICATOR": send({ cm_native: "off" }); break;
      default: break;
    }
  });
})();
