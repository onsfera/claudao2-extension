/*
 * Claudão² - injeção de UI + auto-inject + captura autônoma (v4)
 * --------------------------------------------------------------
 * Sidepanel (script de página) e tabs do claude.ai (content script).
 * Requer globalThis.ClaudeMemory (core.js) e globalThis.LucideIcons (icons.js).
 *  - Memória: gerenciador em tela cheia (lista -> edição) + tela Conectar VS Code.
 *  - Tema claro/escuro (segue o host), i18n pt/en/es.
 *  - Interação externa (Claude do VS Code): glow, banner, trava do input.
 */
(function () {
  "use strict";

  const M = globalThis.ClaudeMemory;
  if (!M) { console.warn("[Claudão²] core.js não carregou; inject abortado."); return; }
  if (globalThis.__claudeMemoryInjected) return;
  globalThis.__claudeMemoryInjected = true;

  const ico = (name, size) => (globalThis.LucideIcons ? globalThis.LucideIcons.get(name, size) : "");
  const IS_SIDEPANEL = location.protocol === "chrome-extension:";

  const HOST_ID = "claude-memory-host";
  const ATTR_SEEN_KEY = "cm_attribution_seen_v1";
  const INSTA_URL = "https://www.instagram.com/ujamatef/";
  const ONSFERA_URL = "https://onsfera.com";
  const ACTIVE_KEY = "cm_external_active";
  const PAUSE_KEY = "cm_external_paused";
  const HANDOFF_KEY = "cm_handoff";
  const STATUS_KEY = "cm_bridge_status";
  const ENABLED_KEY = "cm_bridge_enabled";
  const LOG_KEY = "cm_bridge_log";          // log de ações (auditoria)
  const ALLOW_KEY = "cm_bridge_allowlist";  // domínios aprovados
  const CONSENT_KEY = "cm_bridge_consent";  // pedido de aprovação pendente (SW -> painel)
  const GRANT_KEY = "cm_bridge_grant";      // resposta (painel -> SW): {host, scope, ts}
  const VAULT_KEY = "cm_vault";             // cofre de credenciais
  const ALLOWALL_KEY = "cm_bridge_allow_all"; // aprovar tudo automaticamente (padrão: sim)
  const EXTRELOAD_KEY = "cm_allow_ext_reload"; // deixar o Claude externo recarregar a extensão (padrão: sim)
  const REDACTPII_KEY = "cm_redact_pii";     // borrar campos sensíveis nas screenshots (padrão: não)
  const DEFAULT_ALLOW = ["localhost", "127.0.0.1"];
  // Fallback = caminho REAL desta instalação (o Chrome não sabe o próprio path no disco; noutra
  // máquina o server_hello sobrescreve com o caminho local ao conectar — cm_bridge_paths).
  const BRIDGE_MCP_PATH = "C:/Users/ferna/Desktop/Extensão Claude/extensao-mod/bridge/mcp-server.mjs";
  const BRIDGE_INSTALL_PATH = "C:/Users/ferna/Desktop/Extensão Claude/extensao-mod/bridge/install.mjs";
  const PATHS_KEY = "cm_bridge_paths";
  const BRAND_ORANGE = "#c96442";
  const MARKER_RE = /^[ \t>*\-]*MEM[ÓO]RIA(?:\s*-\s*(APAGAR|REMOVER|DELETE|SUBSTITUIR|TROCAR))?(?:\s*\[([^\]]+)\])?\s*:\s*(.+?)\s*$/gim;

  // ---------------------------------------------------------------------------
  // i18n (pt / en / es)
  // ---------------------------------------------------------------------------
  const LANG_KEY = "cm_lang";      // nossa preferência (auto|pt|en|es)
  const NATIVE_LOCALE_KEY = "preferred_locale"; // idioma escolhido no menu nativo do Claude
  const CONV_KEY = "cm_conversations"; // histórico de conversas salvas
  function normLang(l) {
    l = String(l || "").toLowerCase();
    if (l.startsWith("es")) return "es";
    if (l.startsWith("en")) return "en";
    if (l.startsWith("pt")) return "pt";
    return null;
  }
  function detectLang() {
    let l = null;
    try { l = normLang(chrome.i18n.getUILanguage()); } catch (_) {}
    if (!l) try { l = normLang(navigator.language); } catch (_) {}
    return l || "pt";
  }
  let LANG = detectLang(); // sobrescrito pela preferência salva no boot / no seletor
  const STRINGS = {
    pt: {
      memory: "Memória", integration: "Integração VS Code", new_doc: "Novo documento", back: "Voltar",
      pin_hint: "Fixado (%pin%) = sempre no contexto. Não fixado = recuperado por relevância.",
      insert_all: "Inserir memória na conversa", save_selection: "Salvar seleção da página",
      auto_inject: "Enviar memória automaticamente ao Claude",
      auto_capture: 'Capturar quando o Claude escrever "MEMÓRIA: ..."',
      editor: "Editor", updated: "Memória atualizada", pin_label: "Fixo no contexto", save: "Salvar",
      insert_chat: "Inserir na conversa", content_ph: "Conteúdo markdown do documento...",
      connect_title: "Conectar ao Claude do VS Code", enable_integration: "Ativar integração com o VS Code",
      connect_desc: "Com a integração ligada, o Claude do VS Code (ou Cursor/Windsurf) vê e depura suas páginas por esta extensão — inclusive abas em segundo plano. Rode uma vez para registrar o MCP no Claude Code, Cursor, VS Code e Windsurf:",
      copy_command: "Copiar comando",
      connect_hint: "O caminho é o desta instalação e é confirmado automaticamente ao conectar (serve para qualquer máquina). Servidor sem dependências; desligue quando não usar.",
      st_disabled: "Integração desativada", st_connected: "Conectado ao Claude externo",
      st_waiting: "Ligada — aguardando o Claude do VS Code (rode o comando)",
      ext_banner: "Extensão em interação com o Claude externo —", ext_waiting: "Aguardando o Claude externo…",
      attr_title: "Memória persistente ativada",
      attr_desc: "Esta é uma versão modificada do Claude in Chrome: ele lê, cria e edita os próprios arquivos de memória, que ficam só neste navegador.",
      attr_by: "Desenvolvida por", next: "Próximo",
      t_no_pinned: "Nenhum documento fixado para injetar.", t_inserted: "Memória inserida na conversa.",
      t_no_composer: "Não achei o campo de texto.", t_select_first: "Selecione um texto na página primeiro.",
      t_saved_in: "Salvo em %doc%.", t_copied: "Comando copiado.", t_copy_manual: "Copie manualmente o comando.",
      t_integ_on: "Integração VS Code ligada.", t_integ_off: "Integração VS Code desligada.",
      t_capture_on: "Ativado: o que for conversado será salvo na memória e como histórico de chat.",
      t_capture_off: "Desativado: nada será salvo na memória, nem criará histórico de conversa.",
      capture_on_title: "Captura de memória: LIGADA (clique p/ desligar)", capture_off_title: "Captura de memória: DESLIGADA (clique p/ ligar)",
      t_doc_saved: "Documento salvo.", t_doc_inserted: "Documento inserido na conversa.",
      t_doc_deleted: "Documento apagado.", t_auto: "Memória inserida automaticamente.",
      new_doc_prompt: "Nome do novo documento (ex.: projetos.md):", delete_confirm: "Apagar o documento %doc%?",
      t_removed: "Memória: %n% linha(s) removida(s) de %doc%", t_nomatch: "Memória: nada em %doc% contém isso",
      t_replaced: "Memória: texto substituído em %doc%", t_notfound: "Memória: texto não encontrado em %doc%",
      t_dup: "Memória: já registrado (ignorado)", t_saved: "Memória salva em %doc%",
    },
    en: {
      memory: "Memory", integration: "VS Code integration", new_doc: "New document", back: "Back",
      pin_hint: "Pinned (%pin%) = always in context. Unpinned = retrieved by relevance.",
      insert_all: "Insert memory into chat", save_selection: "Save page selection",
      auto_inject: "Send memory to Claude automatically",
      auto_capture: 'Capture when Claude writes "MEMÓRIA: ..."',
      editor: "Editor", updated: "Memory updated", pin_label: "Pinned in context", save: "Save",
      insert_chat: "Insert into chat", content_ph: "Document markdown content...",
      connect_title: "Connect to Claude in VS Code", enable_integration: "Enable VS Code integration",
      connect_desc: "With the integration on, Claude in VS Code (or Cursor/Windsurf) can see and debug your pages through this extension — including background tabs. Run once to register the MCP in Claude Code, Cursor, VS Code and Windsurf:",
      copy_command: "Copy command",
      connect_hint: "The path points to this install and is confirmed automatically on connect (works on any machine). Dependency-free server; turn it off when unused.",
      st_disabled: "Integration off", st_connected: "Connected to external Claude",
      st_waiting: "On — waiting for Claude in VS Code (run the command)",
      ext_banner: "Extension interacting with external Claude —", ext_waiting: "Waiting for external Claude…",
      attr_title: "Persistent memory enabled",
      attr_desc: "This is a modified build of Claude in Chrome: it reads, creates and edits its own memory files, kept only in this browser.",
      attr_by: "Built by", next: "Next",
      t_no_pinned: "No pinned document to insert.", t_inserted: "Memory inserted into chat.",
      t_no_composer: "Couldn't find the text field.", t_select_first: "Select some text on the page first.",
      t_saved_in: "Saved to %doc%.", t_copied: "Command copied.", t_copy_manual: "Copy the command manually.",
      t_integ_on: "VS Code integration on.", t_integ_off: "VS Code integration off.",
      t_capture_on: "On: what you talk about will be saved to memory and as chat history.",
      t_capture_off: "Off: nothing will be saved to memory, and no chat history will be created.",
      capture_on_title: "Memory capture: ON (click to turn off)", capture_off_title: "Memory capture: OFF (click to turn on)",
      t_doc_saved: "Document saved.", t_doc_inserted: "Document inserted into chat.",
      t_doc_deleted: "Document deleted.", t_auto: "Memory inserted automatically.",
      new_doc_prompt: "New document name (e.g. projects.md):", delete_confirm: "Delete document %doc%?",
      t_removed: "Memory: %n% line(s) removed from %doc%", t_nomatch: "Memory: nothing in %doc% matches that",
      t_replaced: "Memory: text replaced in %doc%", t_notfound: "Memory: text not found in %doc%",
      t_dup: "Memory: already recorded (skipped)", t_saved: "Memory saved to %doc%",
    },
    es: {
      memory: "Memoria", integration: "Integración VS Code", new_doc: "Nuevo documento", back: "Volver",
      pin_hint: "Fijado (%pin%) = siempre en contexto. Sin fijar = recuperado por relevancia.",
      insert_all: "Insertar memoria en el chat", save_selection: "Guardar selección de la página",
      auto_inject: "Enviar memoria a Claude automáticamente",
      auto_capture: 'Capturar cuando Claude escriba "MEMÓRIA: ..."',
      editor: "Editor", updated: "Memoria actualizada", pin_label: "Fijo en contexto", save: "Guardar",
      insert_chat: "Insertar en el chat", content_ph: "Contenido markdown del documento...",
      connect_title: "Conectar con Claude en VS Code", enable_integration: "Activar integración con VS Code",
      connect_desc: "Con la integración activada, Claude en VS Code (o Cursor/Windsurf) ve y depura tus páginas mediante esta extensión — incluidas pestañas en segundo plano. Ejecuta una vez para registrar el MCP en Claude Code, Cursor, VS Code y Windsurf:",
      copy_command: "Copiar comando",
      connect_hint: "La ruta es la de esta instalación y se confirma automáticamente al conectar (sirve para cualquier máquina). Servidor sin dependencias; apágalo cuando no lo uses.",
      st_disabled: "Integración desactivada", st_connected: "Conectado al Claude externo",
      st_waiting: "Activada — esperando a Claude en VS Code (ejecuta el comando)",
      ext_banner: "Extensión interactuando con el Claude externo —", ext_waiting: "Esperando al Claude externo…",
      attr_title: "Memoria persistente activada",
      attr_desc: "Esta es una versión modificada de Claude in Chrome: lee, crea y edita sus propios archivos de memoria, guardados solo en este navegador.",
      attr_by: "Desarrollada por", next: "Siguiente",
      t_no_pinned: "Ningún documento fijado para insertar.", t_inserted: "Memoria insertada en el chat.",
      t_no_composer: "No encontré el campo de texto.", t_select_first: "Selecciona un texto en la página primero.",
      t_saved_in: "Guardado en %doc%.", t_copied: "Comando copiado.", t_copy_manual: "Copia el comando manualmente.",
      t_integ_on: "Integración VS Code activada.", t_integ_off: "Integración VS Code desactivada.",
      t_capture_on: "Activado: lo que converses se guardará en la memoria y como historial de chat.",
      t_capture_off: "Desactivado: nada se guardará en la memoria ni creará historial de conversación.",
      capture_on_title: "Captura de memoria: ACTIVA (clic para desactivar)", capture_off_title: "Captura de memoria: DESACTIVADA (clic para activar)",
      t_doc_saved: "Documento guardado.", t_doc_inserted: "Documento insertado en el chat.",
      t_doc_deleted: "Documento eliminado.", t_auto: "Memoria insertada automáticamente.",
      new_doc_prompt: "Nombre del nuevo documento (ej.: proyectos.md):", delete_confirm: "¿Eliminar el documento %doc%?",
      t_removed: "Memoria: %n% línea(s) eliminada(s) de %doc%", t_nomatch: "Memoria: nada en %doc% coincide",
      t_replaced: "Memoria: texto reemplazado en %doc%", t_notfound: "Memoria: texto no encontrado en %doc%",
      t_dup: "Memoria: ya registrado (ignorado)", t_saved: "Memoria guardada en %doc%",
    },
  };
  // Chaves adicionais (seletor de idioma + histórico de conversas)
  const EXTRA = {
    pt: {
      lang_label: "Idioma", lang_auto: "Automático", conversations: "Conversas", history: "Histórico de conversas",
      no_conversations: "Nenhuma conversa salva ainda.", msgs_count: "%n% mensagens", continue_conv: "Continuar esta conversa",
      conv_reopened: "Continuando esta conversa — é só escrever.", continuing: "Continuando", stop_continue: "Encerrar continuação", delete_conv_confirm: "Apagar esta conversa salva?",
      view_history: "Ver histórico", confirm_close: "Clique de novo para fechar e iniciar uma conversa nova", new_conversation: "Nova conversa iniciada.", today: "Hoje", yesterday: "Ontem", continue_here: "Continue escrevendo abaixo para seguir a conversa", back_to_list: "Voltar à lista de conversas",
      update_available: "Nova versão %v% disponível", view_on_github: "Ver no GitHub", update_now: "Atualizar agora", updating: "Atualizando…", update_failed: "Falha ao atualizar",
      t_copied_short: "Copiado!", check_updates: "Verificar atualizações", checking: "Verificando…", up_to_date: "Você já está na versão mais recente.",
      conv_deleted: "Conversa apagada.", you: "Você", claude: "Claude", lang_changed: "Idioma alterado.",
      rename_conv: "Editar nome", delete_conv: "Excluir", rename_prompt: "Novo nome da conversa:", cancel: "Cancelar",
    },
    en: {
      lang_label: "Language", lang_auto: "Automatic", conversations: "Conversations", history: "Conversation history",
      no_conversations: "No saved conversations yet.", msgs_count: "%n% messages", continue_conv: "Continue this conversation",
      conv_reopened: "Continuing this conversation — just type.", continuing: "Continuing", stop_continue: "Stop continuing", delete_conv_confirm: "Delete this saved conversation?",
      view_history: "View history", confirm_close: "Click again to close and start a new conversation", new_conversation: "New conversation started.", today: "Today", yesterday: "Yesterday", continue_here: "Keep typing below to continue the conversation", back_to_list: "Back to conversation list",
      update_available: "New version %v% available", view_on_github: "View on GitHub", update_now: "Update now", updating: "Updating…", update_failed: "Update failed",
      t_copied_short: "Copied!", check_updates: "Check for updates", checking: "Checking…", up_to_date: "You're on the latest version.",
      conv_deleted: "Conversation deleted.", you: "You", claude: "Claude", lang_changed: "Language changed.",
      rename_conv: "Rename", delete_conv: "Delete", rename_prompt: "New conversation name:", cancel: "Cancel",
    },
    es: {
      lang_label: "Idioma", lang_auto: "Automático", conversations: "Conversaciones", history: "Historial de conversaciones",
      no_conversations: "Aún no hay conversaciones guardadas.", msgs_count: "%n% mensajes", continue_conv: "Continuar esta conversación",
      conv_reopened: "Continuando esta conversación — solo escribe.", continuing: "Continuando", stop_continue: "Terminar continuación", delete_conv_confirm: "¿Eliminar esta conversación guardada?",
      view_history: "Ver historial", confirm_close: "Haz clic de nuevo para cerrar e iniciar una conversación nueva", new_conversation: "Nueva conversación iniciada.", today: "Hoy", yesterday: "Ayer", continue_here: "Sigue escribiendo abajo para continuar la conversación", back_to_list: "Volver a la lista de conversaciones",
      update_available: "Nueva versión %v% disponible", view_on_github: "Ver en GitHub", update_now: "Actualizar ahora", updating: "Actualizando…", update_failed: "Error al actualizar",
      t_copied_short: "¡Copiado!", check_updates: "Buscar actualizaciones", checking: "Verificando…", up_to_date: "Estás en la última versión.",
      conv_deleted: "Conversación eliminada.", you: "Tú", claude: "Claude", lang_changed: "Idioma cambiado.",
      rename_conv: "Editar nombre", delete_conv: "Eliminar", rename_prompt: "Nuevo nombre de la conversación:", cancel: "Cancelar",
    },
  };
  for (const k in EXTRA) Object.assign(STRINGS[k], EXTRA[k]);
  // Chaves de segurança (allowlist, consentimento, log) e cofre
  const EXTRA2 = {
    pt: {
      security: "Segurança", vault: "Cofre",
      paused_by_you: "Claude pausado por você", resume: "Retomar",
      handoff_passed: "passou uma tarefa pra você:", handoff_continue: "Continuar aqui", handoff_reply: "Responder", dismiss: "Dispensar", handoff_sent: "Resposta enviada ao VS Code.",
      auto_approve: "Aprovar tudo automaticamente", auto_approve_hint: "Ligado: o Claude externo age em qualquer site sem pedir. Desligue para exigir aprovação por domínio (a lista abaixo passa a valer).",
      t_autoapprove_on: "Aprovação automática ligada.", t_autoapprove_off: "Aprovação automática desligada — a allowlist agora vale.",
      ext_reload: "Permitir recarregar a extensão", ext_reload_hint: "Deixa o Claude externo recarregar o Claudão² (pega edições de código sem abrir chrome://extensions).",
      t_extreload_on: "Recarregar extensão liberado.", t_extreload_off: "Recarregar extensão bloqueado.",
      redact_pii: "Borrar dados sensíveis nas fotos", redact_pii_hint: "Tarja senha, e-mail, telefone, cartão e CPF nas screenshots antes de irem ao modelo. O Claude opera o formulário sem ver seus dados.",
      t_redact_on: "Redação de dados nas fotos ligada.", t_redact_off: "Redação de dados nas fotos desligada.",
      allowlist_hint: "Ações (clicar, preencher, logar, navegar) só rodam em domínios aprovados. Percepção (ler, console, screenshot) é sempre livre. localhost e 127.0.0.1 já vêm liberados.",
      domain_ph: "ex.: meusite.com", action_log: "Log de ações", no_log: "Nenhuma ação registrada ainda.", clear_log: "Limpar",
      vault_hint: "Credenciais cifradas neste navegador (chave que não sai do dispositivo). O Claude externo referencia pelo nome (credentialRef) e nunca vê o valor.",
      cred_name: "Apelido (ex.: painel-admin)", cred_domain: "Domínio (ex.: meusite.com)", cred_user: "Usuário / e-mail", cred_secret: "Senha / segredo", no_creds: "Nenhuma credencial guardada.",
      consent_title: "Aprovar ação em novo site?", consent_line: "%client% quer executar “%cmd%” em %host%.",
      consent_always: "Permitir sempre neste site", consent_session: "Só nesta sessão", consent_deny: "Recusar", remove: "Remover",
      t_domain_added: "Domínio liberado.", t_domain_removed: "Domínio removido.", t_log_cleared: "Log limpo.",
      t_cred_saved: "Credencial guardada.", t_cred_removed: "Credencial removida.", t_cred_need: "Preencha apelido e senha.",
      t_consent_always: "Site liberado. Peça ao Claude externo para repetir a ação.", t_consent_session: "Liberado nesta sessão. Repita a ação.", t_consent_denied: "Ação recusada.",
    },
    en: {
      security: "Security", vault: "Vault",
      paused_by_you: "Claude paused by you", resume: "Resume",
      handoff_passed: "handed a task to you:", handoff_continue: "Continue here", handoff_reply: "Reply", dismiss: "Dismiss", handoff_sent: "Reply sent to VS Code.",
      auto_approve: "Auto-approve everything", auto_approve_hint: "On: external Claude acts on any site without asking. Turn off to require per-domain approval (the list below then applies).",
      t_autoapprove_on: "Auto-approve on.", t_autoapprove_off: "Auto-approve off — the allowlist now applies.",
      ext_reload: "Allow reloading the extension", ext_reload_hint: "Lets external Claude reload Claudão² (picks up code edits without opening chrome://extensions).",
      t_extreload_on: "Extension reload allowed.", t_extreload_off: "Extension reload blocked.",
      redact_pii: "Blur sensitive data in screenshots", redact_pii_hint: "Black out password, email, phone, card and ID fields in screenshots before they reach the model. Claude works the form without seeing your data.",
      t_redact_on: "Screenshot data redaction on.", t_redact_off: "Screenshot data redaction off.",
      allowlist_hint: "Actions (click, fill, login, navigate) only run on approved domains. Perception (read, console, screenshot) is always free. localhost and 127.0.0.1 are allowed by default.",
      domain_ph: "e.g. mysite.com", action_log: "Action log", no_log: "No actions logged yet.", clear_log: "Clear",
      vault_hint: "Credentials encrypted in this browser (device-bound key). External Claude references them by name (credentialRef) and never sees the value.",
      cred_name: "Alias (e.g. admin-panel)", cred_domain: "Domain (e.g. mysite.com)", cred_user: "Username / email", cred_secret: "Password / secret", no_creds: "No credentials saved.",
      consent_title: "Approve action on a new site?", consent_line: "%client% wants to run “%cmd%” on %host%.",
      consent_always: "Always allow this site", consent_session: "Just this session", consent_deny: "Deny", remove: "Remove",
      t_domain_added: "Domain allowed.", t_domain_removed: "Domain removed.", t_log_cleared: "Log cleared.",
      t_cred_saved: "Credential saved.", t_cred_removed: "Credential removed.", t_cred_need: "Fill alias and password.",
      t_consent_always: "Site allowed. Ask external Claude to retry the action.", t_consent_session: "Allowed this session. Retry the action.", t_consent_denied: "Action denied.",
    },
    es: {
      security: "Seguridad", vault: "Bóveda",
      paused_by_you: "Claude pausado por ti", resume: "Reanudar",
      handoff_passed: "te pasó una tarea:", handoff_continue: "Continuar aquí", handoff_reply: "Responder", dismiss: "Descartar", handoff_sent: "Respuesta enviada a VS Code.",
      auto_approve: "Aprobar todo automáticamente", auto_approve_hint: "Activado: el Claude externo actúa en cualquier sitio sin pedir. Desactívalo para exigir aprobación por dominio (la lista de abajo pasa a valer).",
      t_autoapprove_on: "Aprobación automática activada.", t_autoapprove_off: "Aprobación automática desactivada — la lista ahora vale.",
      ext_reload: "Permitir recargar la extensión", ext_reload_hint: "Deja que el Claude externo recargue Claudão² (toma cambios de código sin abrir chrome://extensions).",
      t_extreload_on: "Recarga de extensión permitida.", t_extreload_off: "Recarga de extensión bloqueada.",
      redact_pii: "Difuminar datos sensibles en las fotos", redact_pii_hint: "Tapa contraseña, correo, teléfono, tarjeta y documento en las capturas antes de ir al modelo. Claude opera el formulario sin ver tus datos.",
      t_redact_on: "Redacción de datos en fotos activada.", t_redact_off: "Redacción de datos en fotos desactivada.",
      allowlist_hint: "Las acciones (clic, rellenar, iniciar sesión, navegar) solo se ejecutan en dominios aprobados. La percepción (leer, consola, captura) siempre es libre. localhost y 127.0.0.1 ya vienen permitidos.",
      domain_ph: "ej.: misitio.com", action_log: "Registro de acciones", no_log: "Aún no hay acciones registradas.", clear_log: "Limpiar",
      vault_hint: "Credenciales cifradas en este navegador (clave que no sale del dispositivo). El Claude externo las referencia por nombre (credentialRef) y nunca ve el valor.",
      cred_name: "Alias (ej.: panel-admin)", cred_domain: "Dominio (ej.: misitio.com)", cred_user: "Usuario / correo", cred_secret: "Contraseña / secreto", no_creds: "No hay credenciales guardadas.",
      consent_title: "¿Aprobar acción en un sitio nuevo?", consent_line: "%client% quiere ejecutar «%cmd%» en %host%.",
      consent_always: "Permitir siempre este sitio", consent_session: "Solo esta sesión", consent_deny: "Rechazar", remove: "Quitar",
      t_domain_added: "Dominio permitido.", t_domain_removed: "Dominio quitado.", t_log_cleared: "Registro limpiado.",
      t_cred_saved: "Credencial guardada.", t_cred_removed: "Credencial quitada.", t_cred_need: "Completa alias y contraseña.",
      t_consent_always: "Sitio permitido. Pide al Claude externo repetir la acción.", t_consent_session: "Permitido esta sesión. Repite la acción.", t_consent_denied: "Acción rechazada.",
    },
  };
  for (const k in EXTRA2) Object.assign(STRINGS[k], EXTRA2[k]);

  function t(key, vars) {
    let s = (STRINGS[LANG] && STRINGS[LANG][key]) || STRINGS.pt[key] || key;
    if (vars) for (const k in vars) s = s.split("%" + k + "%").join(vars[k]);
    return s;
  }

  // ---------------------------------------------------------------------------
  // Configurações + listener de storage
  // ---------------------------------------------------------------------------
  let settings = { autoInject: true, autoCapture: true };
  async function loadSettings() { settings = await M.getSettings(); }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[M.KEY] && changes[M.KEY].newValue) {
      const s = changes[M.KEY].newValue.settings;
      if (s) { settings = s; restyleCaptureBtn(); }
      // memória mudou (inclusive por escrita do Claude externo): atualiza a lista se aberta
      if (panel && panel.style.display !== "none" && $("#cm-screen-list") && $("#cm-screen-list").style.display !== "none") refreshList();
    }
    if (changes[ACTIVE_KEY]) applyExternalState(changes[ACTIVE_KEY].newValue);
    if (changes[PAUSE_KEY]) applyPaused(changes[PAUSE_KEY].newValue);
    if (changes[HANDOFF_KEY]) applyHandoff(changes[HANDOFF_KEY].newValue);
    if (changes[STATUS_KEY] || changes[ENABLED_KEY] || changes[PATHS_KEY]) refreshConnect();
    if ((changes["cm_update"] || changes["cm_update_state"] || changes[STATUS_KEY]) && panel && panel.style.display !== "none" && (curScreen === "list" || curScreen === "connect")) renderUpdateCard(); // slot existe nas 2 telas; sem "connect" o botão "Atualizar agora" trava em "Atualizando…" se o git falhar
    if (changes["cm_update"]) updateMemBadge(); // bolinha de atenção no ícone da memória (independe do painel estar aberto)
    if (changes[CONSENT_KEY]) applyConsent(changes[CONSENT_KEY].newValue);
    if ((changes[LOG_KEY] || changes[ALLOW_KEY]) && curScreen === "security") refreshSecurity();
    if (changes[VAULT_KEY] && curScreen === "vault") refreshVault();
    if (changes[NATIVE_LOCALE_KEY] || changes[LANG_KEY]) reloadLangAndRebuild();
  });

  // ---------------------------------------------------------------------------
  // Injeção REAL da memória (sidepanel): patch no fetch para /v1/messages
  // ---------------------------------------------------------------------------
  const MEM_TAG = "=== MEMÓRIA PERSISTENTE DO CLAUDE";
  const RESUME_TAG = "=== CONVERSA RETOMADA";
  function lastUserText(payload) {
    try {
      const msgs = payload.messages || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== "user") continue;
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) return m.content.filter((b) => b && (b.type === "text" || typeof b.text === "string")).map((b) => b.text || "").join(" ");
      }
    } catch (_) {}
    return "";
  }
  // ---------------------------------------------------------------------------
  // Imagens: a API recusa dimensão acima do limite (2000px em request com várias
  // imagens). Pior que o erro: a imagem grande FICA NO HISTÓRICO e passa a quebrar
  // TODA mensagem seguinte — a conversa "trava". Por isso reduzimos toda imagem do
  // payload antes de enviar, inclusive as antigas: isso cura o histórico sozinho.
  // ---------------------------------------------------------------------------
  const IMG_MAX_DIM = 1568; // maior lado; folgado abaixo do teto de 2000 e é o tamanho que o Claude já usa
  function b64ToBlob(b64, type) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: type || "image/png" });
  }
  function blobToB64(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => { const s = String(fr.result || ""); const i = s.indexOf(","); res(i >= 0 ? s.slice(i + 1) : ""); };
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  }
  // Todo envio remanda o histórico inteiro → sem cache redecodificaríamos cada imagem a cada
  // mensagem. Guarda a impressão digital das que já sabemos estar dentro do limite.
  const imgOkCache = new Set();
  const imgKey = (d) => d.length + ":" + d.slice(0, 24) + d.slice(-16);
  async function shrinkOneImage(src) {
    try {
      if (!src || src.type !== "base64" || !src.data) return false;
      const key0 = imgKey(src.data);
      if (imgOkCache.has(key0)) return false;
      const bmp = await createImageBitmap(b64ToBlob(src.data, src.media_type));
      const w = bmp.width, h = bmp.height, m = Math.max(w, h);
      if (!m || m <= IMG_MAX_DIM) { if (bmp.close) bmp.close(); if (imgOkCache.size > 300) imgOkCache.clear(); imgOkCache.add(key0); return false; }
      const k = IMG_MAX_DIM / m;
      const cv = new OffscreenCanvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
      cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
      if (bmp.close) bmp.close();
      const b64 = await blobToB64(await cv.convertToBlob({ type: "image/jpeg", quality: 0.92 }));
      if (!b64) return false;
      src.data = b64; src.media_type = "image/jpeg";
      if (imgOkCache.size > 300) imgOkCache.clear();
      imgOkCache.add(imgKey(b64)); // a reduzida já está dentro do limite
      return true;
    } catch (_) { return false; }
  }
  async function shrinkInContent(arr) {
    if (!Array.isArray(arr)) return false;
    let changed = false;
    for (const blk of arr) {
      if (!blk) continue;
      if (blk.type === "image" && blk.source) { if (await shrinkOneImage(blk.source)) changed = true; }
      else if (Array.isArray(blk.content)) { if (await shrinkInContent(blk.content)) changed = true; } // tool_result com imagem
    }
    return changed;
  }
  async function shrinkImages(payload) {
    let changed = false;
    try { for (const msg of (payload.messages || [])) { if (msg && Array.isArray(msg.content) && await shrinkInContent(msg.content)) changed = true; } } catch (_) {}
    return changed;
  }

  function patchFetch() {
    if (!IS_SIDEPANEL) return;
    const orig = window.fetch;
    window.fetch = async function (input, init) {
      let doTap = false; // vamos capturar o stream da resposta pra continuação visual ao vivo?
      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
        if (method === "POST" && /\/v1\/messages(?:\?|$)/.test(url)) {
          let bodyText = null;
          if (init && typeof init.body === "string") bodyText = init.body;
          else if (typeof Request !== "undefined" && input instanceof Request) bodyText = await input.clone().text();
          if (bodyText) {
            const payload = JSON.parse(bodyText);
            let modified = false;
            // Roda ANTES e independente do isUtilityCall: imagem grande quebra qualquer request e,
            // ficando no histórico, quebraria todos os próximos. Reduzir aqui cura a conversa travada.
            if (payload && Array.isArray(payload.messages) && await shrinkImages(payload)) modified = true;
            if (payload && Array.isArray(payload.messages) && !isUtilityCall(payload.messages)) {
              const nativeMsgs = payload.messages || [];   // native ANTES do buildResumed
              const beforeLen = nativeMsgs.length;
              handleOutgoing(payload);                 // sessão + continuação (pode setar payload.messages = buildResumed)
              if (payload.messages.length !== beforeLen) modified = true;
              // Grava o histórico em RAW (sem o "[hora]"/flatten que o buildResumed adiciona SÓ pro
              // modelo) — senão o carimbo vazava pro conteúdo salvo e dobrava a cada reabertura.
              recordConversation((resumePrefix && resumePrefix.length) ? resumePrefix.concat(rawFromMessages(nativeMsgs)) : nativeMsgs);
              if (settings.autoInject) {
                const block = await M.compose(lastUserText(payload));
                const sysStr = JSON.stringify(payload.system || "");
                if (block && !sysStr.includes(MEM_TAG)) {
                  if (Array.isArray(payload.system)) payload.system.push({ type: "text", text: block });
                  else if (typeof payload.system === "string" && payload.system) payload.system = payload.system + "\n\n" + block;
                  else payload.system = block;
                  modified = true;
                }
              }
              // Continuação = RAG INTERNO sobre a conversa retomada (não dump). Injeta no `system`:
              // nota + índice + top-K trechos relevantes à mensagem atual (ações ficam ocultas, só
              // emergem se casarem). Independente do autoInject (que governa a memória, não a retomada).
              if (resumePrefix && resumePrefix.length && resumeConv) {
                const rblock = resumeRagBlock(resumeConv, lastUserText(payload));
                const sysStr2 = JSON.stringify(payload.system || "");
                if (rblock && !sysStr2.includes(RESUME_TAG)) {
                  if (Array.isArray(payload.system)) payload.system.push({ type: "text", text: rblock });
                  else if (typeof payload.system === "string" && payload.system) payload.system = payload.system + "\n\n" + rblock;
                  else payload.system = rblock;
                  modified = true;
                }
              }
              // Continuação VISUAL ao vivo: se o overlay está montado, adiciona a mensagem do usuário
              // e marca pra capturar o stream da resposta do assistant (só o TEXTO, ações filtradas).
              if (resumeConv && resumeOv) {
                const ut = extractUserText(lastUserText(payload));
                if (ut && ut !== ovLastUser) { ovLastUser = ut; ovAppendUser(ut); } // nova mensagem do usuário (o loop de tools tem ut vazio)
                doTap = true;
              }
            }
            if (modified) {
              const newBody = JSON.stringify(payload);
              if (init && typeof init.body === "string") init = { ...init, body: newBody };
              else input = new Request(input, { body: newBody, method: "POST" });
            }
          }
        }
      } catch (_) {}
      const res = await orig.call(this, input, init);
      if (doTap) { try { tapResumeStream(res.clone()); } catch (_) {} } // clone: o app lê o original intacto
      return res;
    };
  }
  patchFetch();

  // ---------------------------------------------------------------------------
  // Continuação VISUAL (Eixo B): overlay que ASSUME a área de mensagens do chat nativo e re-injeta
  // a conversa como bolhas (só texto), com scroll natural. A conversa viva (nova msg + resposta do
  // assistant ao vivo, via SSE) segue no mesmo fluxo — indistinguível de continuação real. Não toca
  // no React nativo: overlay opaco por cima da lista (o composer sticky segue visível/interativo).
  // ---------------------------------------------------------------------------
  function ovBubble(role, text, ts, dayTs) {
    if (dayTs == null) dayTs = ts; // dia efetivo (cai pro dia da conversa quando a msg não tem ts)
    const wrap = h("div", { className: "cm-ov-msg " + (role === "user" ? "user" : "asst") });
    if (dayTs != null) wrap.dataset.day = dayLabel(dayTs); // header flutuante/separador usam o dia efetivo
    wrap.appendChild(h("div", { className: "cm-ov-time", textContent: (role === "user" ? t("you") : t("claude")) + (ts ? " · " + hhmm(ts) : "") }));
    const b = h("div", { className: "cm-ov-bubble", textContent: text || "" });
    wrap.appendChild(b);
    return { wrap, bubble: b };
  }
  function ovScroll() { if (resumeOv && ovPinned) resumeOv.scrollTop = resumeOv.scrollHeight; }
  function ovMaybeDay(ts) { // separador por dia (estilo WhatsApp), inclusive entre histórico e ao vivo
    if (!resumeOv || ts == null) return;
    const dk = new Date(ts).toDateString();
    if (dk !== ovLastDay) { ovLastDay = dk; resumeOv.appendChild(h("div", { className: "cm-ov-day", textContent: dayLabel(ts) })); }
  }
  function ovDropHint() { if (resumeOv) { const hn = resumeOv.querySelector(".cm-ov-hint"); if (hn) hn.remove(); } }
  // Header de data FLUTUANTE (estilo WhatsApp): mostra o dia da mensagem no topo da viewport ao rolar,
  // e some sozinho depois. Complementa o separador inline (cm-ov-day) que divide os dias.
  let ovHdrTimer = null;
  function ovUpdateDateHdr() {
    if (!resumeOv) return;
    const hdr = resumeOv.querySelector(".cm-ov-datehdr"); if (!hdr) return;
    const top = resumeOv.scrollTop;
    let day = "";
    const bubbles = resumeOv.querySelectorAll(".cm-ov-msg");
    for (const b of bubbles) { if (b.offsetTop + b.offsetHeight > top + 6) { day = (b.dataset && b.dataset.day) || ""; break; } }
    if (day) { hdr.textContent = day; hdr.classList.add("show"); }
    clearTimeout(ovHdrTimer); ovHdrTimer = setTimeout(() => { const h2 = resumeOv && resumeOv.querySelector(".cm-ov-datehdr"); if (h2) h2.classList.remove("show"); }, 1500);
  }
  function renderChatBubbles(conv) {
    if (!resumeOv) return;
    resumeOv.innerHTML = ""; ovLastDay = "";
    resumeOv.appendChild(h("div", { className: "cm-ov-datehdr" })); // pill flutuante de data (aparece ao rolar)
    const convTs = conv.startedAt || conv.updatedAt || null; // fallback de dia p/ conversas antigas sem ts por mensagem
    for (const m of (conv.messages || [])) {
      const prose = m.role === "user" ? extractUserText(proseOnly(m.content)) : proseOnly(m.content);
      if (!prose || !prose.trim()) continue; // SÓ o que foi escrito (ações/tool/memória ficam fora do visual)
      const dayTs = m.ts != null ? m.ts : convTs;
      ovMaybeDay(dayTs);
      resumeOv.appendChild(ovBubble(m.role, prose.trim(), m.ts, dayTs).wrap);
    }
    resumeOv.appendChild(h("div", { className: "cm-ov-hint", textContent: t("continue_here") }));
  }
  function positionResumeOverlay() {
    if (!resumeOv) return;
    const cont = document.querySelector("[data-autoscroll-container]");
    if (!cont) { resumeOv.style.display = "none"; return; }
    const cr = cont.getBoundingClientRect();
    let bottom = cr.bottom;
    const comp = getComposer();
    if (comp) { const anchor = comp.closest('[class*="sticky"]') || comp; const compTop = anchor.getBoundingClientRect().top; if (compTop > cr.top + 20) bottom = compTop; }
    if (cr.width < 40 || bottom - cr.top < 40) { resumeOv.style.display = "none"; return; }
    resumeOv.style.display = "flex";
    resumeOv.style.left = cr.left + "px";
    resumeOv.style.top = cr.top + "px";
    resumeOv.style.width = cr.width + "px";
    resumeOv.style.height = (bottom - cr.top) + "px";
  }
  function mountResumeOverlay(conv) {
    if (!shadow || !IS_SIDEPANEL) return;
    unmountResumeOverlay();
    resumeOv = h("div", { id: "cm-resume-overlay" });
    resumeOv.addEventListener("scroll", () => { if (resumeOv) { ovPinned = resumeOv.scrollHeight - resumeOv.scrollTop - resumeOv.clientHeight < 60; ovUpdateDateHdr(); } });
    shadow.appendChild(resumeOv);
    ovPinned = true; ovLastUser = "";
    renderChatBubbles(conv);
    positionResumeOverlay(); ovScroll();
    const sync = () => positionResumeOverlay();
    window.addEventListener("resize", sync, true);
    window.addEventListener("scroll", sync, true);
    let ro = null; try { ro = new ResizeObserver(sync); if (cont0()) ro.observe(cont0()); } catch (_) {}
    const iv = setInterval(sync, 400); // âncora pode mudar de tamanho/posição (streaming, topbar)
    resumeOvSync = () => { try { window.removeEventListener("resize", sync, true); window.removeEventListener("scroll", sync, true); if (ro) ro.disconnect(); clearInterval(iv); } catch (_) {} };
  }
  function cont0() { return document.querySelector("[data-autoscroll-container]"); }
  function unmountResumeOverlay() {
    if (resumeOvSync) { try { resumeOvSync(); } catch (_) {} resumeOvSync = null; }
    if (resumeOv) { try { resumeOv.remove(); } catch (_) {} resumeOv = null; }
    ovLastUser = "";
  }
  function ovAppendUser(text) {
    if (!resumeOv || !text) return;
    ovPinned = true; ovDropHint(); ovMaybeDay(Date.now());
    resumeOv.appendChild(ovBubble("user", text, Date.now()).wrap);
    ovScroll();
  }
  // Captura o stream SSE da resposta (clone; não consome o original que vai pro app). Renderiza só
  // o TEXTO do assistant (content_block_delta/text_delta) numa bolha nova; ações/thinking são ignorados.
  async function tapResumeStream(res) {
    try {
      if (!res || !res.body || !resumeOv) return;
      const ct = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
      if (ct && ct.indexOf("text/event-stream") < 0) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", bubble = null;
      const ensure = () => { if (!bubble && resumeOv) { ovPinned = true; ovDropHint(); ovMaybeDay(Date.now()); const b = ovBubble("assistant", "", Date.now()); resumeOv.appendChild(b.wrap); bubble = b.bubble; ovScroll(); } };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, ""); buf = buf.slice(nl + 1);
          if (line.indexOf("data:") !== 0) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          let ev; try { ev = JSON.parse(data); } catch (_) { continue; }
          if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") { ensure(); if (bubble) { bubble.textContent += ev.delta.text; ovScroll(); } }
          else if (ev.type === "message_stop") return;
        }
        if (!resumeOv) return; // usuário fechou a continuação no meio do stream
      }
    } catch (_) {}
  }

  // Responder do mundo MAIN (bridge-capture): nas abas do claude.ai o fetch é interceptado LÁ
  // (o mundo isolado não alcança o window.fetch da página); ele nos manda a query e devolvemos o
  // bloco de memória composto (só nós temos acesso ao chrome.storage). Substitui o auto-inject no
  // composer (que aparecia como texto no campo de mensagem). Respeita o toggle autoInject.
  if (!IS_SIDEPANEL) {
    window.addEventListener("message", async (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.__cmMem !== "need") return;
      let block = "";
      try { if (settings.autoInject) block = await M.compose(d.query || ""); } catch (_) {}
      try { window.postMessage({ __cmMem: "block", id: d.id, block }, location.origin); } catch (_) {}
    });
    // Anuncia que o responder está pronto → o MAIN (que já escuta desde document_start) só tenta
    // injetar depois disto (senão pularia NA HORA, sem pagar timeout). Uma vez basta: ambos os
    // scripts persistem pela vida da página (navegação SPA não recarrega content script).
    try { window.postMessage({ __cmMem: "ready" }, location.origin); } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Idioma (troca ao vivo)
  // ---------------------------------------------------------------------------
  // Modo automático: segue o idioma escolhido no MENU NATIVO do Claude
  // (chrome.storage.local["preferred_locale"], ex.: "en-US", "pt-BR", "es-419").
  async function resolveAutoLang() {
    try {
      const loc = (await chrome.storage.local.get(NATIVE_LOCALE_KEY))[NATIVE_LOCALE_KEY];
      const n = normLang(loc);
      if (n) return n;
      if (loc) return "en"; // idioma nativo que não traduzimos -> inglês
    } catch (_) {}
    return detectLang();
  }
  async function loadLang() {
    let lang;
    try {
      const v = (await chrome.storage.local.get(LANG_KEY))[LANG_KEY];
      const pref = v && v.lang;
      lang = pref && pref !== "auto" ? normLang(pref) : null;
    } catch (_) {}
    LANG = lang || (await resolveAutoLang());
  }
  async function reloadLangAndRebuild() {
    const before = LANG;
    await loadLang();
    if (LANG !== before && shadow && panel) rebuildUI();
  }
  function rebuildUI() {
    if (!shadow || !panel) return;
    panel.innerHTML = panelHTML();
    wirePanel();
    ["cm-extbar", "cm-extlock", "cm-extglow"].forEach((id) => { const e = shadow.getElementById(id); if (e) e.remove(); });
    ensureExternalUI();
    ["cm-topbtn", "cm-topbtn-plug", "cm-topbtn-hist", "cm-topbtn-cap"].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
    mountTopButtons();
    updateResumeBanner();
    showScreen("list"); refreshList(); refreshConnect(); pollExternal();
  }

  // ---------------------------------------------------------------------------
  // Histórico de conversas
  // ---------------------------------------------------------------------------
  function flattenMsg(m) {
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.filter((b) => b && (b.type === "text" || typeof b.text === "string")).map((b) => b.text || "").join(" ");
    return "";
  }
  // Remove molduras do agente (<message>, <conversation>, <system-reminder>...) do texto.
  function cleanMsg(s) {
    return String(s || "")
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ")
      .replace(/<[^>]{1,60}>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  // Extrai a mensagem REAL do usuário de dentro das molduras do agente
  // (<conversation>…<system-reminder>…</system-reminder>…</conversation> + instruções).
  function extractUserText(raw) {
    let s = String(raw || "");
    const conv = s.match(/<conversation>([\s\S]*?)<\/conversation>/i);
    if (conv) s = conv[1];
    s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ").replace(/<[^>]*>/g, " ");
    s = s.replace(/think about it[\s\S]*$/i, " ");
    return s.replace(/\s+/g, " ").trim();
  }
  // Chamadas utilitárias internas do agente (ex.: gerar título) — não são conversas.
  function isUtilityCall(rawMsgs) {
    const all = rawMsgs.map((m) => (typeof m.content === "string" ? m.content : flattenMsg(m))).join(" ");
    return /suggest a title based on|putting it between <title>|between <title> tags/i.test(all);
  }
  function convTitle(msgs) {
    const fu = msgs.find((m) => m.role === "user");
    return ((fu ? fu.text : "") || "(sem título)").slice(0, 90);
  }

  // Identidade por LIMITE DE SESSÃO (não por conteúdo, que o agente reenquadra e
  // trunca): chat novo = POST com 1 mensagem só; qualquer POST com mais mensagens
  // pertence à sessão ativa. Elimina a duplicação.
  let sessionConvId = null, sessionSaw = false, convSeq = 0;
  let resumePrefix = null, resumeConv = null;
  // Overlay de continuação visual (Eixo B): re-injeta a conversa como bolhas na área de mensagens.
  let resumeOv = null, resumeOvSync = null, ovPinned = true, ovLastUser = "", ovLastDay = "";

  // --- Guarda as mensagens CRUAS (preserva tool_use/tool_result = a inteligência
  //     que o agente gera ao interagir com a página). Imagens viram placeholder. ---
  function stripBlocks(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return content;
    return content.map((b) => {
      if (!b || typeof b !== "object") return b;
      if (b.type === "image") return { type: "text", text: "[imagem]" };
      if (b.type === "tool_result" && Array.isArray(b.content))
        return { ...b, content: b.content.map((c) => (c && c.type === "image" ? { type: "text", text: "[imagem]" } : c)) };
      return b;
    });
  }
  function rawFromMessages(messages) {
    return messages.filter((m) => m && (m.role === "user" || m.role === "assistant")).map((m) => ({ role: m.role, content: stripBlocks(m.content) }));
  }
  // Texto legível de uma mensagem, incluindo ações (🔧) e observações (↳) da página.
  function contentText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts = [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === "text" || typeof b.text === "string") parts.push(b.text || "");
      else if (b.type === "tool_use") parts.push("🔧 " + (b.name || "ação") + (b.input ? " " + JSON.stringify(b.input).slice(0, 120) : ""));
      else if (b.type === "tool_result") {
        const inner = Array.isArray(b.content) ? b.content.filter((c) => c && (c.type === "text" || typeof c.text === "string")).map((c) => c.text || "").join(" ") : (typeof b.content === "string" ? b.content : "");
        if (inner) parts.push("↳ " + inner.slice(0, 500));
      }
    }
    return parts.join("\n").trim();
  }
  function msgText(m) {
    const content = m.content !== undefined ? m.content : (m.text || ""); // compat com formato antigo
    return m.role === "user" ? extractUserText(contentText(content)) : contentText(content);
  }
  function convTitle(msgs) {
    const fu = msgs.find((m) => m.role === "user");
    return ((fu ? msgText(fu) : "") || "(sem título)").slice(0, 90);
  }
  function capRaw(msgs, cap) {
    cap = cap || 160000;
    let arr = msgs.slice();
    while (arr.length > 2 && JSON.stringify(arr).length > cap) arr = arr.slice(1);
    while (arr.length && arr[0].role !== "user") arr = arr.slice(1);
    return arr;
  }
  // Carimba um ts por mensagem: casa por CHAVE (role + começo do conteúdo) com o que já estava
  // salvo → mensagens que já existiam preservam seu ts; as NOVAS ganham "agora". Robusto a append
  // (chave nova = agora) e ao capRaw que corta pela frente (chave sumida é ignorada). Serve pro
  // modelo ver o timeline (inline na retomada) e pra UI (separador por dia + horário por card).
  function msgKey(m) { return m.role + "|" + String(m.content == null ? "" : (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).slice(0, 100); }
  function stampTimes(newMsgs, oldMsgs, now) {
    const map = {};
    for (const m of (oldMsgs || [])) if (m && m.ts != null) map[msgKey(m)] = m.ts;
    return newMsgs.map((m) => { const k = msgKey(m); return { role: m.role, content: m.content, ts: (map[k] != null ? map[k] : now) }; });
  }

  function handleOutgoing(payload) {
    const native = payload.messages || [];
    const meaningful = native.filter((m) => m && (m.role === "user" || m.role === "assistant"));
    const cnt = meaningful.length;
    const hasAsst = meaningful.some((m) => m.role === "assistant");
    const isFresh = cnt <= 1 && !hasAsst;
    if (isFresh && sessionSaw) {
      sessionConvId = null; sessionSaw = false;
      if (resumeConv) { resumePrefix = null; resumeConv = null; unmountResumeOverlay(); updateResumeBanner(); } // conversa nova nativa: encerra a continuação (senão o overlay ficaria preso)
    }
    if (!sessionConvId) sessionConvId = "c" + Date.now() + "-" + (convSeq++);
    if (hasAsst || cnt > 1) sessionSaw = true;
    // A continuação NÃO despeja mais a conversa em payload.messages (dump). Ela entra como RAG no
    // `system` (resumeRagBlock, no patchFetch). Aqui só mantemos a identidade de sessão. native intacto.
    return payload.messages;
  }

  function collapseRoles(list) {
    const out = [];
    for (const m of list) {
      if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += "\n\n" + m.content;
      else out.push({ role: m.role, content: m.content });
    }
    return out;
  }
  function trimByBudget(list, budget) {
    let total = 0; const kept = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const len = (list[i].content || "").length + 8;
      if (total + len > budget && kept.length) break;
      total += len; kept.unshift(list[i]);
    }
    return kept;
  }
  // Continuação: converte as mensagens cruas em TEXTO (com 🔧 ações e ↳ observações
  // da página — a inteligência) e prepend, respeitando um orçamento de contexto.
  function buildResumed(prefix, native) {
    let pre = collapseRoles(prefix.map((m) => ({ role: m.role, content: (m.ts ? "[" + new Date(m.ts).toLocaleString() + "] " : "") + msgText(m) })).filter((m) => m.content && m.content.trim()));
    pre = trimByBudget(pre, 16000);
    while (pre.length && pre[0].role !== "user") pre.shift();
    while (pre.length && pre[pre.length - 1].role === "user") pre.pop();
    if (!pre.length) return native;
    return pre.concat(native);
  }

  // --- RAG INTERNO da conversa retomada (Eixo A): em vez de despejar tudo, o modelo recebe uma
  //     nota + um índice do que rolou + os trechos relevantes à pergunta atual. Ações da página
  //     (tool_use/result) entram como contexto OCULTO (indexável, só emerge se casar com a query). ---
  function proseOnly(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.filter((b) => b && (b.type === "text" || typeof b.text === "string")).map((b) => b.text || "").join("\n").trim();
  }
  function actionsOnly(content) {
    if (!Array.isArray(content)) return [];
    const acts = [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === "tool_use") acts.push("🔧 " + (b.name || "ação") + (b.input ? " " + JSON.stringify(b.input).slice(0, 200) : ""));
      else if (b.type === "tool_result") {
        const inner = Array.isArray(b.content) ? b.content.filter((c) => c && (c.type === "text" || typeof c.text === "string")).map((c) => c.text || "").join(" ") : (typeof b.content === "string" ? b.content : "");
        if (inner) acts.push("↳ " + inner.slice(0, 500));
      }
    }
    return acts;
  }
  function convChunks(conv) {
    const out = [];
    for (const m of (conv.messages || [])) {
      const prose = m.role === "user" ? extractUserText(proseOnly(m.content)) : proseOnly(m.content);
      if (prose && prose.trim()) out.push({ role: m.role, ts: m.ts, text: prose.trim(), hidden: false });
      for (const a of actionsOnly(m.content)) out.push({ role: "tool", ts: m.ts, text: a, hidden: true });
    }
    return out;
  }
  function convIndex(conv) {
    const lines = [];
    for (const m of (conv.messages || [])) {
      const prose = m.role === "user" ? extractUserText(proseOnly(m.content)) : proseOnly(m.content);
      const hasAction = Array.isArray(m.content) && m.content.some((b) => b && b.type === "tool_use");
      const snippet = (prose || "").replace(/\s+/g, " ").slice(0, 80);
      if (!snippet && !hasAction) continue;
      const who = m.role === "user" ? t("you") : t("claude");
      lines.push((lines.length + 1) + ". [" + who + (m.ts ? " · " + hhmm(m.ts) : "") + "] " + snippet + (hasAction ? "  🔧" : ""));
      if (lines.length >= 60) break;
    }
    return lines.join("\n");
  }
  function resumeRagBlock(conv, query) {
    const msgs = conv.messages || [];
    if (!msgs.length) return "";
    const chunks = convChunks(conv);
    const top = (query && M.retrieveConversation) ? M.retrieveConversation(query, chunks, { maxChunks: 8, maxChars: 4000 }) : [];
    const vis = top.filter((c) => !c.hidden), hid = top.filter((c) => c.hidden);
    let firstTs = null, lastTs = null;
    for (const m of msgs) { if (m.ts) { if (firstTs == null) firstTs = m.ts; lastTs = m.ts; } }
    let range = "";
    if (firstTs) { range = new Date(firstTs).toLocaleString(); if (lastTs && !sameDay(new Date(firstTs), new Date(lastTs))) range += " – " + new Date(lastTs).toLocaleString(); }
    let s = RESUME_TAG + " (continuação) ===\n";
    s += "Você está CONTINUANDO uma conversa" + (range ? " de " + range : "") + ", com " + msgs.length + " mensagens — NÃO é o começo. O histórico está indexado abaixo; se precisar de algo que não está nos trechos, é só pedir que eu trago.\n";
    s += "--- índice (o que já rolou) ---\n" + convIndex(conv) + "\n";
    if (vis.length) { s += "--- trechos relevantes à minha mensagem atual ---\n"; for (const c of vis) s += "[" + (c.role === "user" ? t("you") : t("claude")) + (c.ts ? " · " + hhmm(c.ts) : "") + "] " + (c.text || "").slice(0, 600) + "\n"; }
    if (hid.length) { s += "--- ações/observações da página que casam ---\n"; for (const c of hid) s += (c.text || "").slice(0, 500) + "\n"; }
    s += "=== FIM DA CONVERSA RETOMADA ===\n";
    return s;
  }

  // Debounce: o agente dispara vários POSTs por turno; grava 1x o estado mais
  // completo, sempre na sessão atual (sessionConvId).
  let pendingMsgs = null, pendingId = null, commitTimer = null;
  function recordConversation(messages) {
    try {
      if (!settings.autoCapture) return; // toggle do cabeçalho: OFF = não grava histórico (nem captura marcador, gated em scanForMarkers)
      if (!Array.isArray(messages) || !messages.length) return;
      const raw = rawFromMessages(messages);
      if (!raw.some((m) => m.role === "user")) return;
      if (pendingId && pendingId !== sessionConvId) { clearTimeout(commitTimer); commitConversation(); }
      if (!pendingMsgs || raw.length >= pendingMsgs.length) { pendingMsgs = raw; pendingId = sessionConvId; }
      clearTimeout(commitTimer);
      commitTimer = setTimeout(commitConversation, globalThis.__CM_CONV_DEBOUNCE || 6000);
    } catch (_) {}
  }
  async function commitConversation() {
    const msgs = pendingMsgs, id = pendingId; pendingMsgs = null; pendingId = null;
    if (!msgs || !id) return;
    try {
      const now = Date.now();
      let list = (await chrome.storage.local.get(CONV_KEY))[CONV_KEY] || [];
      let conv = list.find((c) => c.id === id);
      const capped = capRaw(msgs);
      if (!conv) { conv = { id, title: convTitle(capped), startedAt: now, updatedAt: now, messages: stampTimes(capped, [], now) }; list.push(conv); }
      else { if (msgs.length >= conv.messages.length) conv.messages = stampTimes(capped, conv.messages, now); conv.updatedAt = now; }
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      if (list.length > 40) list = list.slice(0, 40);
      await chrome.storage.local.set({ [CONV_KEY]: list });
      if (panel && panel.style.display !== "none" && $("#cm-screen-history") && $("#cm-screen-history").style.display !== "none") refreshHistory();
    } catch (_) {}
  }

  // --- Continuação de conversa (reabrir) ---
  function startResume(conv) {
    resumeConv = conv;
    resumePrefix = conv.messages || [];   // mensagens cruas (com ferramentas) — pro RAG e recording
    sessionConvId = conv.id;
    sessionSaw = false;
    mountResumeOverlay(conv);              // continuação VISUAL: a conversa reaparece como bolhas
    updateResumeBanner();                 // depois do overlay: o banner suprime o "ver histórico" redundante
    const el = getComposer(); if (el) el.focus();
  }
  function cancelResume() {
    resumePrefix = null; resumeConv = null; sessionConvId = null; sessionSaw = false;
    unmountResumeOverlay();
    updateResumeBanner();
  }
  // Editar o nome da conversa direto no banner (troca o título por um input inline).
  async function bannerRename(strongEl, conv) {
    if (!strongEl || !conv) return;
    const input = h("input", { className: "cm-resume-rename", type: "text", value: conv.title || "" });
    try { strongEl.replaceWith(input); input.focus(); input.select(); } catch (_) { return; }
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      if (save) {
        const name = input.value.trim();
        if (name) {
          conv.title = name.slice(0, 90);
          try { const list = await getConversations(); const cv = list.find((x) => x.id === conv.id); if (cv) { cv.title = conv.title; await chrome.storage.local.set({ [CONV_KEY]: list }); } } catch (_) {}
          if (curScreen === "history") refreshHistory();
        }
      }
      updateResumeBanner();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") finish(false); });
    input.addEventListener("blur", () => finish(true));
  }
  function updateResumeBanner() {
    if (!shadow) return;
    let bar = shadow.getElementById("cm-resumebar");
    if (!resumeConv) { if (bar) bar.style.display = "none"; return; }
    if (!bar) { bar = h("div", { id: "cm-resumebar" }); shadow.appendChild(bar); }
    bar.innerHTML = "";
    const label = h("span", { className: "cm-resume-label" });
    label.innerHTML = ico("messages-square", 13) + " " + t("continuing") + ": ";
    const strong = h("strong", { textContent: (resumeConv.title || "").slice(0, 42), title: resumeConv.title || "" }); // tooltip = nome completo
    const close = h("button", { className: "cm-resume-x", title: t("stop_continue") });
    close.innerHTML = ico("x", 14);
    const back = h("button", { className: "cm-resume-exp", title: t("back_to_list") }); // voltar à lista de conversas
    back.innerHTML = ico("arrow-left", 14);
    back.addEventListener("click", () => openPanel("history"));
    const edit = h("button", { className: "cm-resume-exp", title: t("rename_conv") });
    edit.innerHTML = ico("pencil", 13);
    edit.addEventListener("click", () => bannerRename(strong, resumeConv));
    const top = h("div", { className: "cm-resume-top" });
    top.appendChild(back); top.appendChild(label); top.appendChild(strong); top.appendChild(edit);
    // O overlay (Eixo B) já mostra a conversa inteira e ao vivo; o "ver histórico" expansível do
    // banner só entra como FALLBACK quando o overlay NÃO está ativo (evita a mesma conversa 2x).
    let exp = null, tr = null;
    if (!resumeOv) {
      exp = h("button", { className: "cm-resume-exp", title: t("view_history") });
      exp.innerHTML = ico("history", 14);
      top.appendChild(exp);
      tr = h("div", { className: "cm-resume-tr" });
      tr.style.display = "none";
      renderTranscript(tr, resumeConv.messages);
    }
    top.appendChild(close);
    bar.appendChild(top); if (tr) bar.appendChild(tr);
    bar.style.display = "flex";

    if (exp && tr) {
      let expanded = false;
      exp.addEventListener("click", () => { expanded = !expanded; tr.style.display = expanded ? "flex" : "none"; exp.classList.toggle("on", expanded); if (expanded) tr.scrollTop = tr.scrollHeight; });
    }
    // Fechar exige 2 cliques: 1º arma a confirmação (✓ + aviso), 2º encerra e inicia nova conversa.
    let confirming = false, cTimer = null;
    close.addEventListener("click", () => {
      if (!confirming) {
        confirming = true;
        close.innerHTML = ico("check", 14); close.classList.add("confirm"); close.title = t("confirm_close");
        toast(t("confirm_close"));
        cTimer = setTimeout(() => { confirming = false; try { close.innerHTML = ico("x", 14); close.classList.remove("confirm"); close.title = t("stop_continue"); } catch (_) {} }, 3500);
        return;
      }
      clearTimeout(cTimer);
      cancelResume();
      const el = getComposer(); if (el) { try { el.focus(); } catch (_) {} }
      toast(t("new_conversation"));
    });
  }
  async function getConversations() {
    try { return (await chrome.storage.local.get(CONV_KEY))[CONV_KEY] || []; } catch (_) { return []; }
  }
  let currentConv = null;
  function closeConvMenus() { if (shadow) shadow.querySelectorAll(".cm-conv-menu").forEach((m) => m.remove()); }

  // Conta só as mensagens VISÍVEIS (prosa user/assistant) — não o array cru, que infla com os
  // blocos tool_use/tool_result do loop do agente (1 pergunta virava "55 mensagens").
  function visibleMsgCount(conv) {
    let n = 0;
    for (const m of ((conv && conv.messages) || [])) {
      const prose = m.role === "user" ? extractUserText(proseOnly(m.content)) : proseOnly(m.content);
      if (prose && prose.trim()) n++;
    }
    return n;
  }
  function convCardNormal(card, c) {
    card.className = "cm-card cm-conv-card";
    card.innerHTML = "";
    const icon = h("span", { className: "cm-card-ic" }); icon.innerHTML = ico("messages-square", 16);
    const mid = h("div", { className: "cm-card-mid" }, [
      h("div", { className: "cm-card-name cm-conv-title", textContent: c.title || "(sem título)" }),
      h("div", { className: "cm-card-prev", textContent: new Date(c.updatedAt).toLocaleString() + " · " + t("msgs_count", { n: visibleMsgCount(c) }) }),
    ]);
    const menuBtn = h("button", { className: "cm-conv-menu-btn" });
    menuBtn.innerHTML = ico("more-vertical", 16);
    menuBtn.addEventListener("click", (ev) => { ev.stopPropagation(); toggleConvMenu(card, c); });
    card.appendChild(icon); card.appendChild(mid); card.appendChild(menuBtn);
    // Clicar no card RETOMA direto (sem a tela intermediária de transcript). Rename/excluir seguem no menu ⋮.
    card.onclick = () => { closeConvMenus(); startResume(c); togglePanel(); toast(t("conv_reopened")); };
  }
  function toggleConvMenu(card, c) {
    const existing = card.querySelector(".cm-conv-menu");
    closeConvMenus();
    if (existing) return;
    const menu = h("div", { className: "cm-conv-menu" });
    const rename = h("button", {}); rename.innerHTML = ico("pencil", 14) + " " + t("rename_conv");
    rename.addEventListener("click", (ev) => { ev.stopPropagation(); closeConvMenus(); enterRename(card, c); });
    const del = h("button", { className: "cm-menu-danger" }); del.innerHTML = ico("trash-2", 14) + " " + t("delete_conv");
    del.addEventListener("click", (ev) => { ev.stopPropagation(); closeConvMenus(); enterDelete(card, c); });
    menu.appendChild(rename); menu.appendChild(del);
    card.appendChild(menu);
  }
  function enterRename(card, c) {
    card.className = "cm-card cm-conv-card cm-editing";
    card.onclick = null; card.innerHTML = "";
    const icon = h("span", { className: "cm-card-ic" }); icon.innerHTML = ico("messages-square", 16);
    const input = h("input", { className: "cm-conv-input", type: "text", value: c.title || "" });
    const ok = h("button", { className: "cm-inline-ok", title: t("save") }); ok.innerHTML = ico("check", 15);
    const no = h("button", { className: "cm-inline-x", title: t("cancel") }); no.innerHTML = ico("x", 15);
    const save = async () => {
      const name = input.value.trim();
      if (name) {
        const list = await getConversations();
        const cv = list.find((x) => x.id === c.id);
        if (cv) { cv.title = name.slice(0, 90); await chrome.storage.local.set({ [CONV_KEY]: list }); }
      }
      refreshHistory();
    };
    ok.addEventListener("click", (ev) => { ev.stopPropagation(); save(); });
    no.addEventListener("click", (ev) => { ev.stopPropagation(); refreshHistory(); });
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); save(); } else if (ev.key === "Escape") refreshHistory(); });
    card.appendChild(icon); card.appendChild(input); card.appendChild(ok); card.appendChild(no);
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  function enterDelete(card, c) {
    card.className = "cm-card cm-conv-card cm-confirm";
    card.onclick = null; card.innerHTML = "";
    const label = h("div", { className: "cm-confirm-label", textContent: t("delete_conv_confirm") });
    const ok = h("button", { className: "cm-inline-ok danger", title: t("delete_conv") }); ok.innerHTML = ico("check", 15);
    const no = h("button", { className: "cm-inline-x", title: t("cancel") }); no.innerHTML = ico("x", 15);
    ok.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const list = (await getConversations()).filter((x) => x.id !== c.id);
      await chrome.storage.local.set({ [CONV_KEY]: list });
      refreshHistory(); toast(t("conv_deleted"));
    });
    no.addEventListener("click", (ev) => { ev.stopPropagation(); refreshHistory(); });
    card.appendChild(label); card.appendChild(ok); card.appendChild(no);
  }
  async function refreshHistory() {
    const list = await getConversations();
    const box = $("#cm-convlist");
    box.innerHTML = "";
    if (!list.length) { box.appendChild(h("div", { className: "cm-empty", textContent: t("no_conversations") })); return; }
    for (const c of list) {
      const card = h("div", {});
      convCardNormal(card, c);
      box.appendChild(card);
    }
  }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function dayLabel(ts) {
    const d = new Date(ts), now = new Date(), yst = new Date(now.getTime() - 86400000);
    if (sameDay(d, now)) return t("today");
    if (sameDay(d, yst)) return t("yesterday");
    return d.toLocaleDateString();
  }
  function hhmm(ts) { try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; } }
  // Render de transcript: bolhas + separador por DIA (estilo WhatsApp, quando cruza a meia-noite)
  // + horário por card. Usado no histórico (openConv) e na overlay de retomada. 100% Shadow DOM nosso.
  function renderTranscript(container, messages) {
    container.innerHTML = "";
    let lastDay = "";
    for (const m of messages || []) {
      const txt = msgText(m);
      if (!txt) continue;
      if (m.ts != null) {
        const dk = new Date(m.ts).toDateString();
        if (dk !== lastDay) { lastDay = dk; container.appendChild(h("div", { className: "cm-day-sep", textContent: dayLabel(m.ts) })); }
      }
      const row = h("div", { className: "cm-msg " + (m.role === "user" ? "user" : "asst") });
      const role = h("div", { className: "cm-msg-role" });
      role.textContent = (m.role === "user" ? t("you") : t("claude")) + (m.ts != null ? " · " + hhmm(m.ts) : "");
      row.appendChild(role);
      row.appendChild(h("div", { className: "cm-msg-text", textContent: txt }));
      container.appendChild(row);
    }
  }
  async function openConv(id) {
    const list = await getConversations();
    currentConv = list.find((c) => c.id === id);
    if (!currentConv) return;
    renderTranscript($("#cm-conv-transcript"), currentConv.messages);
    showScreen("conv");
  }

  // ---------------------------------------------------------------------------
  // Composer
  // ---------------------------------------------------------------------------
  function getComposer() {
    return document.querySelector('div.ProseMirror[contenteditable="true"]') ||
      document.querySelector('.ProseMirror[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"]') || document.querySelector("textarea");
  }
  function composerIsEmpty(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return !el.value.trim();
    return (el.innerText || "").replace(/​/g, "").trim() === "";
  }
  function insertIntoComposer(text) {
    const el = getComposer();
    if (!el) return false;
    el.focus();
    if (el.tagName === "TEXTAREA") { el.value = (el.value ? el.value + "\n\n" : "") + text; el.dispatchEvent(new Event("input", { bubbles: true })); return true; }
    const sel = window.getSelection();
    try { sel.selectAllChildren(el); sel.collapseToEnd(); } catch (_) {}
    const ok = document.execCommand("insertText", false, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return ok;
  }
  function getSelectedText() { const s = window.getSelection(); return s ? s.toString().trim() : ""; }

  // ---------------------------------------------------------------------------
  // Shadow DOM + tema
  // ---------------------------------------------------------------------------
  let shadow, panel, hostEl;
  let docsCache = [];
  let currentDoc = null;

  function h(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "style") el.style.cssText = v;
      else if (k === "className") el.className = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else el[k] = v;
    }
    for (const c of [].concat(children)) { if (c == null) continue; el.appendChild(typeof c === "string" ? document.createTextNode(c) : c); }
    return el;
  }
  const $ = (sel) => shadow.querySelector(sel);

  function detectTheme() {
    try {
      const de = document.documentElement;
      const attr = (de.getAttribute("data-theme") || "").toLowerCase();
      const cls = (de.className || "") + " " + ((document.body && document.body.className) || "");
      if (/light/.test(attr) || /(^|\s)light(\s|$)/.test(cls)) return "light";
      if (/dark/.test(attr) || /(^|\s)dark(\s|$)/.test(cls)) return "dark";
      const bg = getComputedStyle(document.body || de).backgroundColor;
      const m = bg && bg.match(/\d+(\.\d+)?/g);
      if (m && m.length >= 3 && !(m[3] !== undefined && parseFloat(m[3]) === 0)) {
        const lum = 0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2];
        return lum > 140 ? "light" : "dark";
      }
    } catch (_) {}
    try { if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) return "light"; } catch (_) {}
    return "dark";
  }
  function applyTheme() { if (hostEl) hostEl.setAttribute("data-cmtheme", detectTheme()); }

  function buildUI() {
    if (document.getElementById(HOST_ID)) return;
    hostEl = h("div", { id: HOST_ID, style: "position:fixed;z-index:2147483647;bottom:0;right:0;width:0;height:0;" });
    (document.body || document.documentElement).appendChild(hostEl);
    shadow = hostEl.attachShadow({ mode: "open" });
    shadow.appendChild(h("style", { textContent: CSS }));
    applyTheme();
    try { if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme); } catch (_) {}

    const fab = h("button", { id: "fab", title: "Claudão² — " + t("memory") });
    fab.innerHTML = ico("brain", 22);
    fab.addEventListener("click", togglePanel);
    shadow.appendChild(fab);

    panel = h("div", { id: "panel", className: IS_SIDEPANEL ? "full" : "popup", style: "display:none" });
    panel.innerHTML = panelHTML();
    shadow.appendChild(panel);
    shadow.appendChild(h("div", { id: "toast" }));
    wirePanel();
  }

  function toast(msg, ok = true) {
    const el = shadow.getElementById("toast");
    el.textContent = msg;
    el.className = ok ? "show ok" : "show err";
    setTimeout(() => (el.className = ""), 2800);
  }

  function openPanel(screen) {
    applyTheme();
    panel.style.display = "flex";
    brandFooter();
    showScreen(screen || "list");
    // ao abrir, re-checa versão (leve, throttle 60s no SW) → o card não mostra uma "latest" velha
    try { chrome.runtime.sendMessage({ cm_update: "check", soft: true }, () => { void chrome.runtime.lastError; }); } catch (_) {}
    if (!screen || screen === "list") refreshList();
    else if (screen === "connect") refreshConnect();
    else if (screen === "history") refreshHistory();
    else if (screen === "security") refreshSecurity();
    else if (screen === "vault") refreshVault();
  }
  function togglePanel() {
    if (panel.style.display === "none") openPanel("list");
    else { panel.style.display = "none"; brandFooter(); }
  }
  let curScreen = "list";
  function screenTitle(name) {
    if (name === "history") return t("conversations");
    if (name === "connect") return t("connect_title");
    if (name === "security") return t("security");
    if (name === "vault") return t("vault");
    if (name === "edit") return currentDoc || t("memory");
    if (name === "conv") return (currentConv && currentConv.title) || t("conversations");
    return t("memory");
  }
  function showScreen(name) {
    curScreen = name;
    ["list", "edit", "connect", "history", "conv", "security", "vault"].forEach((s) => {
      const el = $("#cm-screen-" + s);
      if (el) el.style.display = name === s ? "flex" : "none";
    });
    const ht = $("#cm-head-title"); if (ht) ht.textContent = screenTitle(name);
    const onList = name === "list";
    const hb = $("#cm-hist-btn"), nb = $("#cm-new");
    if (hb) hb.style.display = onList ? "" : "none";
    if (nb) nb.style.display = onList ? "" : "none";
  }
  function headerBack() {
    // edição de doc volta pra lista; detalhe de conversa volta pro histórico;
    // as seções de topo (Memória, Conversas, Integração) fecham o painel.
    if (curScreen === "edit") { showScreen("list"); refreshList(); }
    else if (curScreen === "conv") { showScreen("history"); refreshHistory(); }
    else if (curScreen === "security" || curScreen === "vault") { showScreen("connect"); refreshConnect(); }
    else togglePanel();
  }

  // ---------------------------------------------------------------------------
  // Tela: LISTA
  // ---------------------------------------------------------------------------
  function docPreview(content) {
    return (content || "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).join(" ").slice(0, 110);
  }
  // Aviso de nova versão (a extensão é unpacked). "Ver no GitHub" sempre; "Atualizar agora" só se o
  // bridge está conectado (ele faz o git pull). O estado vem do service worker (checkUpdate → cm_update).
  async function renderUpdateCard() {
    const slots = shadow.querySelectorAll(".cm-update-slot"); if (!slots.length) return;
    let up = null, st = null, up2 = null;
    try { const g = await chrome.storage.local.get(["cm_update", STATUS_KEY, "cm_update_state"]); up = g.cm_update; st = g[STATUS_KEY]; up2 = g.cm_update_state; } catch (_) {}
    const bridgeUp = !!(st && st.hubConnected && Date.now() - (st.ts || 0) < 60000);
    // um nó do DOM só existe num lugar → constrói um card novo por slot (lista + conexão)
    slots.forEach((slot) => {
      slot.innerHTML = "";
      if (!up || !up.hasUpdate) return;
      const card = h("div", { className: "cm-update-card" });
      card.appendChild(h("div", { className: "cm-update-title", textContent: "✨ " + t("update_available", { v: up.latest }) }));
      const row = h("div", { className: "cm-update-actions" });
      const gh = h("button", { className: "cm-update-gh" }); gh.innerHTML = ico("external-link", 14) + " " + t("view_on_github");
      gh.addEventListener("click", () => { try { chrome.tabs.create({ url: up.url }); } catch (_) { try { window.open(up.url, "_blank"); } catch (__) {} } });
      row.appendChild(gh);
      if (bridgeUp) {
        const applying = !!(up2 && up2.applying && Date.now() - (up2.ts || 0) < 120000); // 120s > timeout do git (90s): se o WS cair no meio, o botão não trava eterno
        const btn = h("button", { className: "cm-update-now" });
        btn.innerHTML = applying ? t("updating") : ico("rotate-ccw", 14) + " " + t("update_now");
        btn.disabled = applying;
        btn.addEventListener("click", () => {
          btn.disabled = true; btn.textContent = t("updating");
          try {
            chrome.runtime.sendMessage({ cm_update: "apply" }, (r) => {
              if (!(r && r.ok)) { btn.disabled = false; btn.innerHTML = ico("rotate-ccw", 14) + " " + t("update_now"); toast((r && r.error) || t("update_failed"), false); }
            });
          } catch (_) { btn.disabled = false; }
        });
        row.appendChild(btn);
      }
      card.appendChild(row);
      if (up2 && up2.ok === false && up2.error) card.appendChild(h("div", { className: "cm-update-err", textContent: "⚠ " + up2.error }));
      slot.appendChild(card);
    });
  }
  async function refreshList() {
    renderUpdateCard();
    const mem = await M.load();
    docsCache = mem.docs;
    $("#cm-auto-inject").checked = !!mem.settings.autoInject;
    $("#cm-auto-capture").checked = !!mem.settings.autoCapture;
    const list = $("#cm-doclist");
    list.innerHTML = "";
    for (const d of docsCache) {
      const card = h("div", { className: "cm-card" });
      const icon = h("span", { className: "cm-card-ic" }); icon.innerHTML = ico("file-text", 16);
      const mid = h("div", { className: "cm-card-mid" }, [
        h("div", { className: "cm-card-name", textContent: d.name }),
        h("div", { className: "cm-card-prev", textContent: docPreview(d.content) || "(vazio)" }),
      ]);
      const pin = h("button", { className: "cm-pin-btn" + (d.pinned ? " on" : ""), title: d.pinned ? t("pin_label") : "" });
      pin.innerHTML = ico("pin", 15);
      pin.addEventListener("click", async (ev) => { ev.stopPropagation(); await M.setPinned(d.name, !d.pinned); refreshList(); });
      card.appendChild(icon); card.appendChild(mid); card.appendChild(pin);
      card.addEventListener("click", () => openDoc(d.name));
      list.appendChild(card);
    }
    $("#cm-updated").textContent = t("updated") + ": " + (mem.updatedAt ? new Date(mem.updatedAt).toLocaleString() : "—") + " · v" + (chrome.runtime.getManifest().version || "?");
  }

  // ---------------------------------------------------------------------------
  // Tela: EDIÇÃO
  // ---------------------------------------------------------------------------
  function openDoc(name) {
    currentDoc = name;
    const d = docsCache.find((x) => x.name === name);
    $("#cm-content").value = d ? d.content : "";
    $("#cm-pin").checked = d ? !!d.pinned : false;
    showScreen("edit");
  }

  function wirePanel() {
    $("#cm-close").addEventListener("click", headerBack);
    $("#cm-new").addEventListener("click", async () => {
      let name = prompt(t("new_doc_prompt"), "novo.md");
      if (!name) return;
      name = name.trim(); if (!/\.md$/i.test(name)) name += ".md";
      await M.upsertDoc(name, "# " + name.replace(/\.md$/i, "") + "\n\n", true);
      await refreshList(); openDoc(name);
    });
    $("#cm-insert-all").addEventListener("click", async () => {
      const block = await M.compose();
      if (!block) return toast(t("t_no_pinned"), false);
      const ok = insertIntoComposer(block);
      toast(ok ? t("t_inserted") : t("t_no_composer"), ok);
      if (ok) togglePanel();
    });
    $("#cm-save-selection").addEventListener("click", async () => {
      const sel = getSelectedText();
      if (!sel) return toast(t("t_select_first"), false);
      const r = await M.capture(sel);
      toast(t("t_saved_in", { doc: r ? r.doc : M.DEFAULT_TARGET }));
      refreshList();
    });
    $("#cm-auto-inject").addEventListener("change", (e) => M.setSetting("autoInject", e.target.checked));
    $("#cm-auto-capture").addEventListener("change", (e) => M.setSetting("autoCapture", e.target.checked));
    $("#cm-editor").addEventListener("click", () => window.open(chrome.runtime.getURL("memory/editor.html"), "_blank"));

    $("#cm-copy").addEventListener("click", async () => {
      const btn = $("#cm-copy");
      const cmd = shadow.getElementById("cm-cmd-text").textContent;
      let ok = false;
      try { await navigator.clipboard.writeText(cmd); ok = true; } catch (_) {
        try { // fallback sem permissão de clipboard (textarea + execCommand)
          const ta = document.createElement("textarea"); ta.value = cmd;
          ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
          document.body.appendChild(ta); ta.focus(); ta.select();
          ok = document.execCommand("copy"); ta.remove();
        } catch (__) {}
      }
      if (ok) { // efeito "Copiado!" no próprio botão (restaura o rótulo canônico, resiste a duplo-clique)
        if (btn._cmT) clearTimeout(btn._cmT);
        btn.innerHTML = "✓ " + t("t_copied_short"); btn.classList.add("cm-copied");
        btn._cmT = setTimeout(() => { btn.innerHTML = ico("copy", 14) + " " + t("copy_command"); btn.classList.remove("cm-copied"); btn._cmT = null; }, 1600);
      } else { toast(t("t_copy_manual"), false); }
    });
    $("#cm-check-update").addEventListener("click", () => {
      toast(t("checking"));
      try {
        chrome.runtime.sendMessage({ cm_update: "check" }, async () => {
          await renderUpdateCard();
          try { const g = await chrome.storage.local.get("cm_update"); if (!(g.cm_update && g.cm_update.hasUpdate)) toast(t("up_to_date")); } catch (_) {}
        });
      } catch (_) {}
    });
    $("#cm-bridge-enabled").addEventListener("change", async (e) => {
      await chrome.storage.local.set({ [ENABLED_KEY]: { on: e.target.checked, ts: Date.now() } });
      toast(e.target.checked ? t("t_integ_on") : t("t_integ_off"));
      refreshConnect();
    });

    // Segurança & Cofre
    $("#cm-go-security").addEventListener("click", () => { showScreen("security"); refreshSecurity(); });
    $("#cm-go-vault").addEventListener("click", () => { showScreen("vault"); refreshVault(); });
    $("#cm-allow-all").addEventListener("change", async (e) => {
      await chrome.storage.local.set({ [ALLOWALL_KEY]: e.target.checked });
      toast(e.target.checked ? t("t_autoapprove_on") : t("t_autoapprove_off"));
      refreshSecurity();
    });
    $("#cm-ext-reload").addEventListener("change", async (e) => {
      await chrome.storage.local.set({ [EXTRELOAD_KEY]: e.target.checked });
      toast(e.target.checked ? t("t_extreload_on") : t("t_extreload_off"));
    });
    $("#cm-redact-pii").addEventListener("change", async (e) => {
      await chrome.storage.local.set({ [REDACTPII_KEY]: e.target.checked });
      toast(e.target.checked ? t("t_redact_on") : t("t_redact_off"));
    });
    $("#cm-allow-add").addEventListener("click", addDomain);
    $("#cm-allow-input").addEventListener("keydown", (e) => { if (e.key === "Enter") addDomain(); });
    $("#cm-log-clear").addEventListener("click", async () => { await chrome.storage.local.set({ [LOG_KEY]: [] }); refreshSecurity(); toast(t("t_log_cleared")); });
    $("#cm-cred-save").addEventListener("click", saveCred);

    // Histórico de conversas
    $("#cm-hist-btn").addEventListener("click", () => { showScreen("history"); refreshHistory(); });
    $("#cm-conv-continue").addEventListener("click", () => {
      if (!currentConv) return;
      startResume(currentConv);
      togglePanel();
      toast(t("conv_reopened"));
    });
    $("#cm-conv-delete").addEventListener("click", (e) => {
      const btn = e.currentTarget, bar = btn.parentElement;
      if (bar.querySelector(".cm-inline-ok")) return;
      btn.style.display = "none";
      const ok = h("button", { className: "cm-icon cm-inline-ok danger", title: t("delete_conv") }); ok.innerHTML = ico("check", 16);
      const no = h("button", { className: "cm-icon cm-inline-x", title: t("cancel") }); no.innerHTML = ico("x", 16);
      const cleanup = () => { ok.remove(); no.remove(); btn.style.display = ""; };
      ok.addEventListener("click", async () => {
        if (!currentConv) return cleanup();
        const list = (await getConversations()).filter((c) => c.id !== currentConv.id);
        await chrome.storage.local.set({ [CONV_KEY]: list });
        currentConv = null;
        showScreen("history"); refreshHistory(); toast(t("conv_deleted"));
      });
      no.addEventListener("click", cleanup);
      bar.appendChild(ok); bar.appendChild(no);
    });

    $("#cm-pin").addEventListener("change", async (e) => { if (currentDoc) await M.setPinned(currentDoc, e.target.checked); });
    $("#cm-save").addEventListener("click", async () => {
      if (!currentDoc) return;
      await M.upsertDoc(currentDoc, $("#cm-content").value, $("#cm-pin").checked);
      toast(t("t_doc_saved"));
    });
    $("#cm-insert-doc").addEventListener("click", () => {
      const ok = insertIntoComposer($("#cm-content").value.trim());
      toast(ok ? t("t_doc_inserted") : t("t_no_composer"), ok);
      if (ok) togglePanel();
    });
    $("#cm-delete").addEventListener("click", async () => {
      if (!currentDoc) return;
      if (!confirm(t("delete_confirm", { doc: currentDoc }))) return;
      await M.deleteDoc(currentDoc); currentDoc = null;
      showScreen("list"); refreshList(); toast(t("t_doc_deleted"));
    });
  }

  // ---------------------------------------------------------------------------
  // Botões no topo do sidepanel (memória + integração), laranja, tamanho nativo
  // ---------------------------------------------------------------------------
  function mountTopButtons() {
    if (!IS_SIDEPANEL || document.getElementById("cm-topbtn")) return;
    const btns = Array.from(document.querySelectorAll("button")).filter((b) => {
      if (b.id && b.id.indexOf("cm-") === 0) return false;
      const r = b.getBoundingClientRect();
      return r.top >= 0 && r.top < 56 && r.height > 8 && r.height < 48 && r.width > 8;
    });
    if (!btns.length) return;
    btns.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    const anchor = btns[Math.min(1, btns.length - 1)];
    if (!anchor || !anchor.parentElement) return;
    const sz = Math.max(28, Math.min(40, Math.round(anchor.getBoundingClientRect().height))) || 34;
    const mk = (id, icon, title, onclick) => {
      const b = document.createElement("button");
      b.id = id; b.title = title; b.type = "button"; b.innerHTML = ico(icon, 19);
      b.style.cssText = "background:none;border:none;cursor:pointer;color:" + BRAND_ORANGE + ";opacity:.92;" +
        "height:" + sz + "px;width:" + sz + "px;padding:0;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;transition:opacity .15s,background .15s;";
      b.addEventListener("mouseenter", () => { b.style.opacity = "1"; b.style.background = "rgba(201,100,66,.14)"; });
      b.addEventListener("mouseleave", () => { b.style.opacity = ".92"; b.style.background = "none"; });
      b.addEventListener("click", (e) => { e.stopPropagation(); onclick(); });
      return b;
    };
    const plugBtn = mk("cm-topbtn-plug", "plug", "Claudão² — " + t("integration"), () => openPanel("connect"));
    const histBtn = mk("cm-topbtn-hist", "history", "Claudão² — " + t("history"), () => openPanel("history"));
    const memBtn = mk("cm-topbtn", "brain", "Claudão² — " + t("memory"), () => openPanel("list"));
    const capBtn = mk("cm-topbtn-cap", "save", "", () => {
      const v = !settings.autoCapture; settings.autoCapture = v;
      M.setSetting("autoCapture", v);
      toast(v ? t("t_capture_on") : t("t_capture_off"), v);
      restyleCaptureBtn();
    });
    anchor.parentElement.insertBefore(plugBtn, anchor);
    anchor.parentElement.insertBefore(histBtn, plugBtn);
    anchor.parentElement.insertBefore(memBtn, histBtn);
    anchor.parentElement.insertBefore(capBtn, memBtn);
    restyleCaptureBtn();
    updateMemBadge();
  }
  // Reflete o estado do toggle de captura no botão do cabeçalho (cor/opacidade/tooltip).
  function restyleCaptureBtn() {
    const b = document.getElementById("cm-topbtn-cap"); if (!b) return;
    const on = !!settings.autoCapture;
    b.style.color = on ? BRAND_ORANGE : "#9a958c";
    b.style.opacity = on ? ".92" : ".5";
    b.title = "Claudão² — " + (on ? t("capture_on_title") : t("capture_off_title"));
  }
  // Bolinha de atenção no ícone do cérebro (memória) quando há nova versão disponível.
  async function updateMemBadge() {
    const btn = document.getElementById("cm-topbtn"); if (!btn) return;
    let latest = "";
    try { const g = await chrome.storage.local.get("cm_update"); if (g.cm_update && g.cm_update.hasUpdate) latest = g.cm_update.latest || "•"; } catch (_) {}
    let dot = btn.querySelector("#cm-topbtn-dot");
    if (latest) {
      if (!document.getElementById("cm-dot-style")) {
        const st = document.createElement("style"); st.id = "cm-dot-style";
        st.textContent = "@keyframes cmDotPulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.35);opacity:.55}}";
        (document.head || document.documentElement).appendChild(st);
      }
      btn.style.position = "relative";
      if (!dot) {
        dot = document.createElement("span"); dot.id = "cm-topbtn-dot";
        dot.style.cssText = "position:absolute;top:3px;right:3px;width:8px;height:8px;border-radius:50%;background:#ff4d4d;box-shadow:0 0 0 2px rgba(20,20,22,.55);pointer-events:none;animation:cmDotPulse 1.6s ease-in-out infinite;";
        btn.appendChild(dot);
      }
      dot.title = "Claudão² — " + t("update_available", { v: latest });
      dot.style.display = "block";
    } else if (dot) { dot.style.display = "none"; }
  }
  function syncFabVisibility() {
    const fab = shadow && shadow.getElementById("fab");
    if (!fab) return;
    fab.style.display = IS_SIDEPANEL && document.getElementById("cm-topbtn") ? "none" : "flex";
  }

  // ---------------------------------------------------------------------------
  // Rodapé: mantém o disclaimer ORIGINAL do Claude e adiciona a linha da Onsfera
  // logo abaixo (não esconde nem edita o disclaimer — só localiza e posiciona).
  // ---------------------------------------------------------------------------
  const FOOTER_RE = /Claude\s+(é uma IA|can make mistakes|puede cometer errores|peut faire des erreurs|kann Fehler)/i;
  function ensureBrandBar() {
    let bar = shadow.getElementById("cm-brandbar");
    if (!bar) {
      bar = h("div", { id: "cm-brandbar", style: "display:none" });
      bar.innerHTML = '<span>Powered by <a href="' + ONSFERA_URL + '" target="_blank" rel="noopener"><strong>Onsfera</strong></a>' +
        ' · <a href="' + INSTA_URL + '" target="_blank" rel="noopener">' + ico("instagram", 12) + " @ujamatef</a></span>";
      shadow.appendChild(bar);
    }
    return bar;
  }
  function findDisclaimerEl() {
    if (!document.body) return null;
    let best = null;
    for (const el of document.body.querySelectorAll("p, span, div, small")) {
      const raw = el.textContent || "";
      if (raw.length > 160) continue;
      if (!FOOTER_RE.test(raw.replace(/\s+/g, " ").trim())) continue;
      if (!best || raw.length < best.textContent.length) best = el;
    }
    return best;
  }
  function brandFooter() {
    if (!IS_SIDEPANEL || !shadow) return;
    const bar = ensureBrandBar();
    if (panel && panel.style.display !== "none") { bar.style.display = "none"; return; } // painel cobre tudo
    const el = findDisclaimerEl();
    if (el) {
      // mantém o disclaimer original visível; abre um respiro abaixo dele e
      // coloca a linha Onsfera nesse espaço (com folga do disclaimer).
      if (el.style.visibility === "hidden") el.style.visibility = "";
      if (el.style.marginBottom !== "20px") el.style.setProperty("margin-bottom", "20px", "important");
      const r = el.getBoundingClientRect();
      if (r.height > 0) {
        bar.style.display = "flex";
        bar.style.top = (Math.round(r.bottom) + 5) + "px";
        bar.style.height = "14px";
      }
    } else bar.style.display = "none";
  }

  // ---------------------------------------------------------------------------
  // Atribuição (primeira execução)
  // ---------------------------------------------------------------------------
  async function maybeShowAttribution() {
    if (!IS_SIDEPANEL) return;
    const out = await chrome.storage.local.get(ATTR_SEEN_KEY);
    if (out && out[ATTR_SEEN_KEY]) return;
    const ov = h("div", { id: "cm-attr" });
    ov.innerHTML = '<div class="cm-attr-card"><div class="cm-attr-ic">' + ico("brain", 44) + "</div>" +
      "<h2>" + t("attr_title") + "</h2><p>" + t("attr_desc") + "</p>" +
      '<p class="cm-attr-by">' + t("attr_by") + " <strong>Fernando Martins</strong></p>" +
      '<p><a href="' + INSTA_URL + '" target="_blank" rel="noopener">' + ico("instagram", 15) + " @ujamatef</a></p></div>";
    const nextBtn = h("button", { className: "cm-attr-next", textContent: t("next") });
    nextBtn.addEventListener("click", async () => { await chrome.storage.local.set({ [ATTR_SEEN_KEY]: true }); ov.remove(); });
    ov.querySelector(".cm-attr-card").appendChild(nextBtn);
    shadow.appendChild(ov);
  }

  // ---------------------------------------------------------------------------
  // Interação externa
  // ---------------------------------------------------------------------------
  function prettyClient(name) {
    const n = String(name || "").toLowerCase();
    if (n.includes("claude-code") || n.includes("claude code")) return "Claude Code";
    if (n.includes("cursor")) return "Cursor";
    if (n.includes("windsurf")) return "Windsurf";
    if (n.includes("vscode") || n.includes("vs code") || n.includes("code")) return "VS Code";
    return name ? String(name) : "Claude externo";
  }
  function externalFresh(st) { return !!(st && st.active && Date.now() - (st.ts || 0) < 15000); }
  function ensureExternalUI() {
    if (!shadow || shadow.getElementById("cm-extglow")) return;
    shadow.appendChild(h("div", { id: "cm-extglow", style: "display:none" }));
    const bar = h("div", { id: "cm-extbar", style: "display:none" });
    bar.innerHTML = ico("cpu", 13) + " " + t("ext_banner") + ' <strong class="cm-extbar-name"></strong>';
    shadow.appendChild(bar);
    const lock = h("div", { id: "cm-extlock", style: "display:none" });
    lock.innerHTML = "<span>" + ico("cpu", 15) + " " + t("ext_waiting") + "</span>";
    shadow.appendChild(lock);
    const pause = h("div", { id: "cm-pausebar", style: "display:none" });
    pause.innerHTML = '<span>⏸ ' + t("paused_by_you") + '<span class="cm-pause-count"></span></span>';
    const resume = h("button", { className: "cm-pause-resume", textContent: t("resume") });
    resume.addEventListener("click", () => { try { chrome.storage.local.set({ [PAUSE_KEY]: { tabs: {} } }); } catch (_) {} }); // "Retomar tudo"
    pause.appendChild(resume);
    shadow.appendChild(pause);
  }
  function applyPaused(st) {
    if (!IS_SIDEPANEL || !shadow) return;
    ensureExternalUI();
    const bar = shadow.getElementById("cm-pausebar");
    const n = st && st.tabs ? Object.keys(st.tabs).length : 0;
    if (bar) { bar.style.display = n ? "flex" : "none"; const c = bar.querySelector(".cm-pause-count"); if (c) c.textContent = n > 1 ? " · " + n + " páginas" : ""; }
  }
  async function pollPaused() {
    if (!IS_SIDEPANEL) return;
    try { applyPaused((await chrome.storage.local.get(PAUSE_KEY))[PAUSE_KEY]); } catch (_) {}
  }

  // Handoff: o Claude do VS Code passou uma tarefa → card no painel para o Claude
  // nativo do navegador (ou o usuário) assumir. Compartilham a mesma memória.
  async function getHandoff() { try { return (await chrome.storage.local.get(HANDOFF_KEY))[HANDOFF_KEY] || {}; } catch (_) { return {}; } }
  function ensureHandoffUI() { if (!shadow || shadow.getElementById("cm-handoff")) return; shadow.appendChild(h("div", { id: "cm-handoff", style: "display:none" })); }
  let handoffSig = null;
  function applyHandoff(hf) {
    if (!IS_SIDEPANEL || !shadow) return;
    ensureHandoffUI();
    const box = shadow.getElementById("cm-handoff");
    if (!hf || !hf.message || hf.dismissed) { box.style.display = "none"; handoffSig = null; return; }
    const sig = hf.ts + ""; if (handoffSig === sig) return; handoffSig = sig;
    box.innerHTML = "";
    const card = h("div", { className: "cm-handoff-card" }, [
      h("div", { className: "cm-handoff-from", innerHTML: "🤝 <strong>" + escapeHtml(prettyClient(hf.from)) + "</strong> " + t("handoff_passed") }),
      h("div", { className: "cm-handoff-msg", textContent: hf.message }),
    ]);
    const cont = h("button", { className: "cm-primary", textContent: t("handoff_continue") });
    cont.addEventListener("click", async () => { insertIntoComposer(hf.message); const cur = await getHandoff(); cur.seen = true; cur.dismissed = true; try { await chrome.storage.local.set({ [HANDOFF_KEY]: cur }); } catch (_) {} box.style.display = "none"; togglePanel(); });
    const rep = h("button", { className: "cm-handoff-reply", textContent: t("handoff_reply") });
    rep.addEventListener("click", async () => { const r = prompt(t("handoff_reply")); if (r == null) return; const cur = await getHandoff(); cur.reply = r; try { await chrome.storage.local.set({ [HANDOFF_KEY]: cur }); } catch (_) {} toast(t("handoff_sent")); });
    const dis = h("button", { className: "cm-handoff-dismiss", textContent: t("dismiss") });
    dis.addEventListener("click", async () => { const cur = await getHandoff(); cur.dismissed = true; try { await chrome.storage.local.set({ [HANDOFF_KEY]: cur }); } catch (_) {} box.style.display = "none"; });
    card.appendChild(h("div", { className: "cm-handoff-btns" }, [cont, rep, dis]));
    box.appendChild(card); box.style.display = "flex";
  }
  async function pollHandoff() {
    if (!IS_SIDEPANEL) return;
    try { applyHandoff((await chrome.storage.local.get(HANDOFF_KEY))[HANDOFF_KEY]); } catch (_) {}
  }
  function positionLock(lock) {
    const el = getComposer();
    let top = window.innerHeight - 130, height = 130;
    if (el) {
      const box = el.closest("form") || el.parentElement || el;
      const r = (box || el).getBoundingClientRect();
      if (r && r.height > 0) { top = r.top - 12; height = window.innerHeight - top; }
    }
    lock.style.top = Math.max(0, top) + "px"; lock.style.height = height + "px"; lock.style.left = "0"; lock.style.right = "0";
  }
  async function applyExternalState(st) {
    if (!IS_SIDEPANEL || !shadow) return;
    ensureExternalUI();
    let on = externalFresh(st);
    if (on) {
      // Escopo por aba: só sinaliza/trava se o Claude externo está agindo na aba ATIVA desta janela.
      // Se ele age em OUTRA aba (ou em nenhuma específica), o usuário segue livre pra usar a extensão aqui.
      let sameTab = false;
      if (st && st.tab != null) {
        try { const act = await chrome.tabs.query({ active: true, currentWindow: true }); sameTab = !!(act && act[0] && act[0].id === st.tab); } catch (_) {}
      }
      on = sameTab;
    }
    const glow = shadow.getElementById("cm-extglow");
    const bar = shadow.getElementById("cm-extbar");
    const lock = shadow.getElementById("cm-extlock");
    if (on) {
      bar.querySelector(".cm-extbar-name").textContent = prettyClient(st.client);
      glow.style.display = "block"; bar.style.display = "block";
      positionLock(lock); lock.style.display = "flex";
    } else { glow.style.display = "none"; bar.style.display = "none"; lock.style.display = "none"; }
  }
  async function pollExternal() {
    if (!IS_SIDEPANEL) return;
    try { applyExternalState((await chrome.storage.local.get(ACTIVE_KEY))[ACTIVE_KEY]); } catch (_) {}
  }

  async function refreshConnect() {
    if (!shadow) return;
    const dot = shadow.getElementById("cm-conn-dot");
    const txt = shadow.getElementById("cm-conn-text");
    const chk = shadow.getElementById("cm-bridge-enabled");
    const codeEl = shadow.getElementById("cm-cmd-text");
    let on = false, up = false, realInstall = "";
    try {
      const g = await chrome.storage.local.get([ENABLED_KEY, STATUS_KEY, PATHS_KEY]);
      if (g[PATHS_KEY] && g[PATHS_KEY].install) realInstall = g[PATHS_KEY].install;
      on = !!(g[ENABLED_KEY] && g[ENABLED_KEY].on);
      up = !!(g[STATUS_KEY] && g[STATUS_KEY].hubConnected && Date.now() - (g[STATUS_KEY].ts || 0) < 60000);
    } catch (_) {}
    if (codeEl) codeEl.textContent = 'node "' + (realInstall || BRIDGE_INSTALL_PATH) + '"';
    if (chk) chk.checked = on;
    renderUpdateCard(); // aviso de nova versão também aparece aqui na tela de conexão
    if (!dot || !txt) return;
    if (!on) { dot.className = "cm-dot off"; txt.textContent = t("st_disabled"); }
    else if (up) { dot.className = "cm-dot on"; txt.textContent = t("st_connected"); }
    else { dot.className = "cm-dot off"; txt.textContent = t("st_waiting"); }
  }

  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // ---------------------------------------------------------------------------
  // Segurança: allowlist de domínios + log de ações
  // ---------------------------------------------------------------------------
  async function getAllowlist() {
    try { const v = (await chrome.storage.local.get(ALLOW_KEY))[ALLOW_KEY]; if (Array.isArray(v) && v.length) return v; } catch (_) {}
    return DEFAULT_ALLOW.slice();
  }
  function setAllowlist(list) { return chrome.storage.local.set({ [ALLOW_KEY]: list }); }
  function normDomain(d) { return (d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, ""); }
  async function addDomain() {
    const inp = shadow.getElementById("cm-allow-input"); if (!inp) return;
    const d = normDomain(inp.value); if (!d) return;
    const list = await getAllowlist();
    if (!list.includes(d)) list.push(d);
    await setAllowlist(list);
    inp.value = ""; refreshSecurity(); toast(t("t_domain_added"));
  }
  async function refreshSecurity() {
    if (!shadow) return;
    let allowAll = true;
    try { const v = (await chrome.storage.local.get(ALLOWALL_KEY))[ALLOWALL_KEY]; allowAll = v == null ? true : !!v; } catch (_) {}
    const chk = shadow.getElementById("cm-allow-all"); if (chk) chk.checked = allowAll;
    try { const rv = (await chrome.storage.local.get(EXTRELOAD_KEY))[EXTRELOAD_KEY]; const rchk = shadow.getElementById("cm-ext-reload"); if (rchk) rchk.checked = rv == null ? true : !!rv; } catch (_) {}
    try { const pv = (await chrome.storage.local.get(REDACTPII_KEY))[REDACTPII_KEY]; const pchk = shadow.getElementById("cm-redact-pii"); if (pchk) pchk.checked = !!pv; } catch (_) {}
    // Com "aprovar tudo" ligado, a allowlist fica inativa (esmaecida).
    const addrow = shadow.querySelector("#cm-screen-security .cm-addrow");
    if (addrow) addrow.style.opacity = allowAll ? ".45" : "1";
    const list = await getAllowlist();
    const box = shadow.getElementById("cm-allowlist");
    if (box) box.style.opacity = allowAll ? ".45" : "1";
    if (box) {
      box.innerHTML = "";
      for (const d of list) {
        const row = h("div", { className: "cm-allowrow" });
        const label = h("span", { className: "cm-allowname", innerHTML: ico("globe", 13) + " " + escapeHtml(d) });
        const rm = h("button", { className: "cm-icon", title: t("remove"), innerHTML: ico("x", 14) });
        if (DEFAULT_ALLOW.includes(d)) { rm.disabled = true; rm.style.opacity = ".28"; }
        else rm.addEventListener("click", async () => { await setAllowlist((await getAllowlist()).filter((x) => x !== d)); refreshSecurity(); toast(t("t_domain_removed")); });
        row.appendChild(label); row.appendChild(rm); box.appendChild(row);
      }
    }
    const logBox = shadow.getElementById("cm-actionlog");
    if (logBox) {
      let log = [];
      try { log = (await chrome.storage.local.get(LOG_KEY))[LOG_KEY] || []; } catch (_) {}
      logBox.innerHTML = "";
      if (!log.length) { logBox.appendChild(h("div", { className: "cm-empty", textContent: t("no_log") })); }
      else for (const e of log.slice(-60).reverse()) {
        const row = h("div", { className: "cm-logrow" + (e.ok ? "" : (e.needsConsent ? " warn" : " err")) });
        const head = h("div", { className: "cm-logtop" }, [
          h("span", { className: "cm-logcmd", textContent: e.cmd || "?" }),
          h("span", { className: "cm-loghost", textContent: e.host || "" }),
          h("span", { className: "cm-logtime", textContent: new Date(e.t || 0).toLocaleTimeString() }),
        ]);
        row.appendChild(head);
        const sub = (e.summary || "") + (e.ok ? "" : " · " + (e.needsConsent ? "aguardando aprovação" : (e.error || "erro")));
        if (sub.trim()) row.appendChild(h("div", { className: "cm-logsub", textContent: sub }));
        logBox.appendChild(row);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cofre de credenciais
  // ---------------------------------------------------------------------------
  async function getVault() {
    try { const v = (await chrome.storage.local.get(VAULT_KEY))[VAULT_KEY]; if (v && Array.isArray(v.items)) return v.items; } catch (_) {}
    return [];
  }
  async function saveCred() {
    const name = (shadow.getElementById("cm-cred-name").value || "").trim();
    const domain = normDomain(shadow.getElementById("cm-cred-domain").value);
    const username = (shadow.getElementById("cm-cred-user").value || "").trim();
    const value = shadow.getElementById("cm-cred-secret").value || "";
    if (!name || !value) return toast(t("t_cred_need"), false);
    // A chave de cifra vive no service worker → delega a ele cifrar+guardar.
    let saved = false;
    try { const r = await chrome.runtime.sendMessage({ cm_vault: "save", item: { name, domain, username, value } }); saved = !!(r && r.ok); } catch (_) {}
    if (!saved) { // fallback (SW indisponível): guarda em texto puro
      const items = await getVault();
      const idx = items.findIndex((it) => it.domain === domain && it.name === name);
      const rec = { id: domain + "/" + name, domain, name, username, value, ts: Date.now() };
      if (idx >= 0) items[idx] = rec; else items.push(rec);
      await chrome.storage.local.set({ [VAULT_KEY]: { items } });
    }
    ["cm-cred-name", "cm-cred-domain", "cm-cred-user", "cm-cred-secret"].forEach((id) => { const el = shadow.getElementById(id); if (el) el.value = ""; });
    refreshVault(); toast(t("t_cred_saved"));
  }
  async function refreshVault() {
    if (!shadow) return;
    const items = await getVault();
    const box = shadow.getElementById("cm-vaultlist");
    if (!box) return;
    box.innerHTML = "";
    if (!items.length) { box.appendChild(h("div", { className: "cm-empty", textContent: t("no_creds") })); return; }
    for (const it of items) {
      const row = h("div", { className: "cm-credrow" });
      const ic = h("span", { className: "cm-card-ic", innerHTML: ico("key", 15) });
      const mid = h("div", { className: "cm-credmid" }, [
        h("div", { className: "cm-credname", textContent: it.name }),
        h("div", { className: "cm-credsub", textContent: (it.domain || "—") + (it.username ? " · " + it.username : "") + " · ••••••" }),
      ]);
      const rm = h("button", { className: "cm-icon", title: t("remove"), innerHTML: ico("trash-2", 15) });
      rm.addEventListener("click", async () => {
        const list = (await getVault()).filter((x) => !(x.name === it.name && x.domain === it.domain));
        await chrome.storage.local.set({ [VAULT_KEY]: { items: list } });
        refreshVault(); toast(t("t_cred_removed"));
      });
      row.appendChild(ic); row.appendChild(mid); row.appendChild(rm); box.appendChild(row);
    }
  }

  // ---------------------------------------------------------------------------
  // Consentimento inline: card quando uma ação chega para um domínio não aprovado
  // ---------------------------------------------------------------------------
  function ensureConsentUI() {
    if (!shadow || shadow.getElementById("cm-consent")) return;
    shadow.appendChild(h("div", { id: "cm-consent", style: "display:none" }));
  }
  let consentSig = null;
  async function clearConsent() {
    consentSig = null;
    const c = shadow && shadow.getElementById("cm-consent"); if (c) c.style.display = "none";
    try { await chrome.storage.local.remove(CONSENT_KEY); } catch (_) {}
  }
  function applyConsent(state) {
    if (!IS_SIDEPANEL || !shadow) return;
    ensureConsentUI();
    const c = shadow.getElementById("cm-consent");
    const fresh = state && state.host !== undefined && Date.now() - (state.ts || 0) < 120000;
    if (!fresh) { if (c.style.display !== "none") c.style.display = "none"; consentSig = null; return; }
    const sig = (state.host || "") + "|" + state.ts;
    if (consentSig === sig) return; // já mostrando
    consentSig = sig;
    const host = state.host || "?";
    const card = h("div", { className: "cm-consent-card" }, [
      h("div", { className: "cm-consent-ic", innerHTML: ico("shield", 30) }),
      h("h3", { textContent: t("consent_title") }),
      h("p", { className: "cm-consent-line", innerHTML: t("consent_line", { client: "<strong>" + escapeHtml(prettyClient(state.client)) + "</strong>", cmd: escapeHtml(state.cmd || ""), host: "<strong>" + escapeHtml(host) + "</strong>" }) }),
    ]);
    const always = h("button", { className: "cm-primary", textContent: t("consent_always") });
    const sess = h("button", { className: "cm-consent-sess", textContent: t("consent_session") });
    const deny = h("button", { className: "cm-consent-deny", textContent: t("consent_deny") });
    always.addEventListener("click", async () => {
      const list = await getAllowlist(); if (host && host !== "?" && !list.includes(host)) list.push(host);
      await setAllowlist(list); await clearConsent(); toast(t("t_consent_always"));
    });
    sess.addEventListener("click", async () => {
      await chrome.storage.local.set({ [GRANT_KEY]: { host, scope: "session", ts: Date.now() } });
      await clearConsent(); toast(t("t_consent_session"));
    });
    deny.addEventListener("click", async () => { await clearConsent(); toast(t("t_consent_denied"), false); });
    const btns = h("div", { className: "cm-consent-btns" }, [always, sess, deny]);
    card.appendChild(btns);
    c.innerHTML = ""; c.appendChild(card); c.style.display = "flex";
  }
  async function pollConsent() {
    if (!IS_SIDEPANEL) return;
    try { applyConsent((await chrome.storage.local.get(CONSENT_KEY))[CONSENT_KEY]); } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Auto-inject (só nos tabs claude.ai; no sidepanel é via patchFetch)
  // ---------------------------------------------------------------------------
  let autoInjectDone = false;
  async function maybeAutoInject() {
    // APOSENTADO: a memória agora entra INVISÍVEL no `system` do request (via bridge-capture, mundo
    // MAIN + o responder de postMessage acima), em vez de ser despejada no CAMPO DE MENSAGEM. Mantido
    // como no-op p/ não quebrar as chamadas no loop de montagem da UI.
    return;
  }
  let lastUrl = location.href;
  function watchUrl() { if (location.href !== lastUrl) { lastUrl = location.href; autoInjectDone = false; } }

  // ---------------------------------------------------------------------------
  // Captura autônoma
  // ---------------------------------------------------------------------------
  function hashStr(s) { let x = 0; for (let i = 0; i < s.length; i++) { x = (x << 5) - x + s.charCodeAt(i); x |= 0; } return "h" + x; }
  async function scanForMarkers(root) {
    if (!settings.autoCapture || !root || root.id === HOST_ID) return;
    const text = root.textContent || "";
    if (!text.includes("MEM")) return;
    const hits = [];
    MARKER_RE.lastIndex = 0;
    let mm;
    while ((mm = MARKER_RE.exec(text)) !== null) {
      const verb = (mm[1] || "").toUpperCase();
      const file = mm[2] ? mm[2].trim() : "";
      const value = (mm[3] || "").trim();
      if (value) hits.push({ verb, file, value });
    }
    let changed = false;
    for (const hit of hits) {
      const hash = hashStr(hit.verb + "|" + (hit.file || "") + "|" + hit.value);
      if (await M.isMarkerSaved(hash)) continue;
      await M.markMarkerSaved(hash);
      const target = hit.file || M.DEFAULT_TARGET;
      if (hit.verb === "APAGAR" || hit.verb === "REMOVER" || hit.verb === "DELETE") {
        const n = await M.removeLines(target, hit.value);
        toast(n ? t("t_removed", { n: n, doc: target }) : t("t_nomatch", { doc: target }), !!n);
        changed = changed || !!n;
      } else if (hit.verb === "SUBSTITUIR" || hit.verb === "TROCAR") {
        const parts = hit.value.split(/\s*>>>\s*/);
        if (parts.length >= 2 && parts[0].trim()) {
          const n = await M.replaceText(target, parts[0].trim(), parts.slice(1).join(" >>> ").trim());
          toast(n ? t("t_replaced", { doc: target }) : t("t_notfound", { doc: target }), !!n);
          changed = changed || !!n;
        }
      } else {
        const r = await M.capture(hit.value, hit.file);
        if (r && r.duplicate) toast(t("t_dup"));
        else { toast(t("t_saved", { doc: r ? r.doc : M.DEFAULT_TARGET })); changed = true; }
      }
    }
    if (changed && panel && panel.style.display !== "none") refreshList();
  }

  // ---------------------------------------------------------------------------
  // Observers + boot
  // ---------------------------------------------------------------------------
  function startObservers() {
    const obs = new MutationObserver((mutations) => {
      watchUrl();
      for (const mu of mutations) for (const node of mu.addedNodes) if (node.nodeType === 1 && node.id !== HOST_ID) scanForMarkers(node);
      mountTopButtons(); syncFabVisibility(); brandFooter(); maybeAutoInject();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("resize", brandFooter);
    let tries = 0;
    const iv = setInterval(() => { mountTopButtons(); syncFabVisibility(); brandFooter(); applyTheme(); maybeAutoInject(); if (++tries > 40) clearInterval(iv); }, 500);
  }
  async function boot() {
    await loadLang();
    buildUI();
    loadSettings().finally(startObservers);
    maybeShowAttribution();
    if (IS_SIDEPANEL) { ensureExternalUI(); ensureConsentUI(); ensureHandoffUI(); pollExternal(); pollConsent(); pollPaused(); pollHandoff(); refreshConnect(); setInterval(() => { pollExternal(); pollConsent(); pollPaused(); pollHandoff(); }, 2500);
      // troca de aba re-avalia o lock na hora (a trava só vale na aba que o Claude externo está agindo)
      try { chrome.tabs.onActivated.addListener(() => pollExternal()); } catch (_) {}
    }
  }

  // ---------------------------------------------------------------------------
  // Markup / CSS
  // ---------------------------------------------------------------------------
  function panelHTML() { return `
    <div id="cm-head">
      <span class="cm-title">${ico("brain", 18)} <span id="cm-head-title">${t("memory")}</span></span>
      <span class="cm-actions">
        <button id="cm-hist-btn" class="cm-icon" title="${t("history")}">${ico("history", 18)}</button>
        <button id="cm-new" class="cm-icon" title="${t("new_doc")}">${ico("plus", 17)}</button>
        <button id="cm-close" class="cm-icon" title="${t("back")}">${ico("arrow-left", 18)}</button>
      </span>
    </div>

    <div id="cm-screen-list" class="cm-screen">
      <div class="cm-update-slot"></div>
      <div class="cm-hint">${t("pin_hint", { pin: ico("pin", 11) })}</div>
      <div id="cm-doclist"></div>
      <div class="cm-listactions">
        <button id="cm-insert-all" class="cm-primary">${ico("corner-down-left", 15)} ${t("insert_all")}</button>
        <button id="cm-save-selection">${ico("bookmark", 15)} ${t("save_selection")}</button>
      </div>
      <div class="cm-toggles">
        <label><input type="checkbox" id="cm-auto-inject" /> ${t("auto_inject")}</label>
        <label><input type="checkbox" id="cm-auto-capture" /> ${t("auto_capture")}</label>
      </div>
      <div id="cm-foot">
        <span id="cm-updated"></span>
        <button id="cm-editor" class="cm-mini">${ico("external-link", 13)} ${t("editor")}</button>
      </div>
    </div>

    <div id="cm-screen-history" class="cm-screen">
      <div id="cm-convlist"></div>
    </div>

    <div id="cm-screen-conv" class="cm-screen">
      <div class="cm-editbar cm-bar-right">
        <button id="cm-conv-delete" class="cm-icon" title="${t("delete_conv")}">${ico("trash-2", 16)}</button>
      </div>
      <div id="cm-conv-transcript"></div>
      <div class="cm-editactions">
        <button id="cm-conv-continue" class="cm-primary">${ico("corner-down-left", 15)} ${t("continue_conv")}</button>
      </div>
    </div>

    <div id="cm-screen-edit" class="cm-screen">
      <div class="cm-editbar cm-bar-right">
        <label class="cm-pinline"><input type="checkbox" id="cm-pin" /> ${ico("pin", 13)} ${t("pin_label")}</label>
      </div>
      <textarea id="cm-content" spellcheck="false" placeholder="${t("content_ph")}"></textarea>
      <div class="cm-row cm-editactions">
        <button id="cm-save" class="cm-primary">${ico("save", 15)} ${t("save")}</button>
        <button id="cm-insert-doc">${ico("corner-down-left", 15)} ${t("insert_chat")}</button>
        <button id="cm-delete" class="cm-danger">${ico("trash-2", 15)}</button>
      </div>
    </div>

    <div id="cm-screen-connect" class="cm-screen">
      <div class="cm-connect">
        <div class="cm-update-slot"></div>
        <label class="cm-conn-toggle"><input type="checkbox" id="cm-bridge-enabled" /> <span>${t("enable_integration")}</span></label>
        <div class="cm-conn-status"><span class="cm-dot off" id="cm-conn-dot"></span> <span id="cm-conn-text"></span></div>
        <p class="cm-conn-p">${t("connect_desc")}</p>
        <div class="cm-cmd"><code id="cm-cmd-text"></code></div>
        <button id="cm-copy" class="cm-primary">${ico("copy", 14)} ${t("copy_command")}</button>
        <p class="cm-conn-hint">${t("connect_hint")}</p>
        <button id="cm-check-update" class="cm-check-update">${ico("rotate-ccw", 12)} ${t("check_updates")}</button>
        <div class="cm-conn-nav">
          <button id="cm-go-security" class="cm-secbtn">${ico("shield", 15)} ${t("security")}</button>
          <button id="cm-go-vault" class="cm-secbtn">${ico("key", 15)} ${t("vault")}</button>
        </div>
      </div>
    </div>

    <div id="cm-screen-security" class="cm-screen">
      <label class="cm-conn-toggle"><input type="checkbox" id="cm-allow-all" /> <span>${t("auto_approve")}</span></label>
      <p class="cm-conn-hint">${t("auto_approve_hint")}</p>
      <label class="cm-conn-toggle"><input type="checkbox" id="cm-ext-reload" /> <span>${t("ext_reload")}</span></label>
      <p class="cm-conn-hint">${t("ext_reload_hint")}</p>
      <label class="cm-conn-toggle"><input type="checkbox" id="cm-redact-pii" /> <span>${t("redact_pii")}</span></label>
      <p class="cm-conn-hint">${t("redact_pii_hint")}</p>
      <p class="cm-conn-p">${t("allowlist_hint")}</p>
      <div class="cm-addrow">
        <input id="cm-allow-input" placeholder="${t("domain_ph")}" />
        <button id="cm-allow-add" class="cm-primary">${ico("plus", 15)}</button>
      </div>
      <div id="cm-allowlist"></div>
      <div class="cm-seclog-head"><strong>${t("action_log")}</strong><button id="cm-log-clear" class="cm-mini">${ico("trash-2", 12)} ${t("clear_log")}</button></div>
      <div id="cm-actionlog"></div>
    </div>

    <div id="cm-screen-vault" class="cm-screen">
      <p class="cm-conn-p">${t("vault_hint")}</p>
      <div id="cm-vaultlist"></div>
      <div class="cm-vaultform">
        <input id="cm-cred-name" placeholder="${t("cred_name")}" />
        <input id="cm-cred-domain" placeholder="${t("cred_domain")}" />
        <input id="cm-cred-user" placeholder="${t("cred_user")}" autocomplete="off" />
        <input id="cm-cred-secret" type="password" placeholder="${t("cred_secret")}" autocomplete="new-password" />
        <button id="cm-cred-save" class="cm-primary">${ico("save", 14)} ${t("save")}</button>
      </div>
    </div>
  `; }

  const CSS = `
    :host { all: initial; }
    :host {
      --bg:#1f1e1d; --head:#2a2826; --card:#26241f; --card-hover:#2c2a25; --field:#141312;
      --text:#f0eee6; --muted:#a3a096; --dim:#8a8880; --faint:#5c5a54;
      --border:#3a3836; --border2:#4a4844; --border-card:#2f2d2b;
      --accent:#7867fd; --accent2:#9d90ff; --btn:#34322e; --btn-hover:#403d38;
      --danger:#ff9b9b; --danger-border:#5a3a3a; --green:#56c26a;
      --attr-bg:#262624; --neutral-bg:#faf9f5; --neutral-text:#1f1e1d; --overlay:rgba(20,19,18,.55);
      --shadow:rgba(0,0,0,.5);
    }
    :host([data-cmtheme="light"]) {
      --bg:#ffffff; --head:#f5f3ee; --card:#f7f5f0; --card-hover:#efece5; --field:#faf9f5;
      --text:#1f1e1d; --muted:#6b6862; --dim:#8a8880; --faint:#b8b4ac;
      --border:#e7e4dc; --border2:#d6d3ca; --border-card:#e7e4dc;
      --accent:#7867fd; --accent2:#6b5bd6; --btn:#efece5; --btn-hover:#e5e2da;
      --danger:#c0392b; --danger-border:#e6c3bd; --green:#3aa856;
      --attr-bg:#faf9f5; --neutral-bg:#2a2826; --neutral-text:#faf9f5; --overlay:rgba(250,249,245,.6);
      --shadow:rgba(60,50,40,.22);
    }
    * { box-sizing: border-box; }
    .lucide { flex: none; vertical-align: middle; }

    #fab { position: fixed; bottom: 18px; right: 18px; width: 44px; height: 44px; border-radius: 50%; z-index: 46;
      border: none; cursor: pointer; background: var(--accent); color: #fff;
      box-shadow: 0 4px 14px rgba(0,0,0,.28); display: flex; align-items: center; justify-content: center; }
    #fab:hover { filter: brightness(1.08); }

    #panel { background: var(--bg); color: var(--text); flex-direction: column; overflow: hidden; z-index: 50;
      font-family: system-ui, -apple-system, sans-serif; font-size: 13px; }
    #panel.popup { position: fixed; bottom: 72px; right: 18px; width: 380px; max-height: 80vh;
      border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 12px 40px var(--shadow); }
    #panel.full { position: fixed; inset: 0; width: 100%; height: 100%; }

    #cm-head { display: flex; justify-content: space-between; align-items: center; padding: 13px 16px;
      background: var(--head); font-weight: 600; flex: none; }
    .cm-title { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; min-width: 0; }
    #cm-head-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 210px; }
    .cm-actions { display: inline-flex; gap: 4px; }
    button.cm-icon { background: none; border: none; color: var(--muted); cursor: pointer; padding: 4px;
      display: inline-flex; border-radius: 6px; }
    button.cm-icon:hover { color: var(--text); background: var(--border); }

    .cm-screen { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .cm-hint { padding: 10px 16px 8px; color: var(--muted); font-size: 11.5px; line-height: 1.55; flex: none; }
    .cm-hint .lucide { vertical-align: -2px; margin: 0 1px; }
    #cm-doclist { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 12px; display: flex; flex-direction: column; gap: 6px; }
    .cm-card { display: flex; align-items: center; gap: 10px; padding: 11px 12px; border-radius: 10px;
      background: var(--card); border: 1px solid var(--border-card); cursor: pointer; transition: border-color .12s, background .12s; }
    .cm-card:hover { background: var(--card-hover); border-color: var(--border2); }
    .cm-card-ic { color: var(--muted); display: inline-flex; }
    .cm-card-mid { flex: 1; min-width: 0; }
    .cm-card-name { font-family: ui-monospace, monospace; font-size: 12.5px; color: var(--text); }
    .cm-card-prev { color: var(--dim); font-size: 11.5px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cm-pin-btn { background: none; border: none; cursor: pointer; color: var(--faint); padding: 6px; border-radius: 6px; display: inline-flex; }
    .cm-pin-btn:hover { background: var(--border); }
    .cm-pin-btn.on { color: var(--accent2); }

    .cm-listactions { padding: 10px 16px 0; display: flex; flex-direction: column; gap: 7px; flex: none; }
    .cm-toggles { display: flex; flex-direction: column; gap: 7px; padding: 12px 16px; color: var(--text); flex: none; }
    .cm-toggles label { display: flex; gap: 8px; align-items: center; cursor: pointer; font-size: 12px; }

    button { background: var(--btn); color: var(--text); border: 1px solid var(--border2); border-radius: 8px;
      padding: 8px 12px; cursor: pointer; font-size: 12.5px; font-family: inherit;
      display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
    button:hover { background: var(--btn-hover); }
    button.cm-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.cm-primary:hover { filter: brightness(1.08); }
    button.cm-danger { border-color: var(--danger-border); color: var(--danger); }
    button.cm-mini { padding: 5px 9px; font-size: 11px; }

    #cm-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px;
      padding: 11px 16px; border-top: 1px solid var(--border); background: var(--card); font-size: 11.5px;
      color: var(--muted); flex: none; }

    /* Histórico de conversas */
    #cm-convlist { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 12px 6px; display: flex; flex-direction: column; gap: 6px; }
    .cm-conv-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: system-ui, sans-serif !important; }
    .cm-empty { color: var(--dim); font-size: 12.5px; font-style: italic; padding: 18px 8px; text-align: center; }
    #cm-conv-transcript { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 14px; display: flex; flex-direction: column; gap: 10px; }
    .cm-msg { display: flex; flex-direction: column; gap: 3px; }
    .cm-msg-role { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--dim); }
    .cm-msg-text { font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
      background: var(--card); border: 1px solid var(--border-card); border-radius: 8px; padding: 8px 10px; }
    .cm-msg.user .cm-msg-text { background: var(--field); }
    .cm-conv-card { position: relative; }
    .cm-conv-menu-btn { background: none; border: none; color: var(--faint); cursor: pointer; padding: 5px; border-radius: 6px; display: inline-flex; flex: none; }
    .cm-conv-menu-btn:hover { background: var(--border); color: var(--text); }
    .cm-conv-menu { position: absolute; top: 42px; right: 10px; z-index: 5; background: var(--head); border: 1px solid var(--border2);
      border-radius: 8px; box-shadow: 0 8px 22px var(--shadow); display: flex; flex-direction: column; overflow: hidden; min-width: 150px; }
    .cm-conv-menu button { background: none; border: none; border-radius: 0; justify-content: flex-start; gap: 8px; padding: 9px 12px; font-size: 12.5px; color: var(--text); }
    .cm-conv-menu button:hover { background: var(--card-hover); }
    .cm-conv-menu .cm-menu-danger { color: var(--danger); }
    .cm-card.cm-editing, .cm-card.cm-confirm { cursor: default; }
    .cm-conv-input { flex: 1; min-width: 0; background: var(--field); color: var(--text); border: 1px solid var(--accent);
      border-radius: 7px; padding: 7px 9px; font-size: 12.5px; font-family: inherit; }
    .cm-confirm-label { flex: 1; min-width: 0; font-size: 12.5px; color: var(--text); }
    .cm-inline-ok, .cm-inline-x { background: none; border: none; cursor: pointer; padding: 6px; border-radius: 6px;
      display: inline-flex; flex: none; color: var(--muted); }
    .cm-inline-ok:hover { background: var(--border); color: var(--green); }
    .cm-inline-ok.danger:hover { color: var(--danger); }
    .cm-inline-x:hover { background: var(--border); color: var(--text); }

    .cm-editbar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; flex: none; }
    .cm-editbar.cm-bar-right { justify-content: flex-end; }
    .cm-edit-name { flex: 1; min-width: 0; font-family: ui-monospace, monospace; font-size: 13px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
    .cm-pinline { display: inline-flex; gap: 5px; align-items: center; color: var(--text); font-size: 12px; cursor: pointer; flex: none; }
    #cm-content { flex: 1; min-height: 0; margin: 0 14px; resize: none; background: var(--field); color: var(--text);
      border: 1px solid var(--border); border-radius: 10px; padding: 12px;
      font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.6; }
    .cm-editactions { padding: 12px 14px; flex: none; }
    .cm-row { display: flex; gap: 7px; flex-wrap: wrap; }
    .cm-row .cm-primary { flex: 1; }

    #cm-attr { position: fixed; inset: 0; background: var(--attr-bg); display: flex; align-items: center;
      justify-content: center; padding: 28px; font-family: system-ui, -apple-system, sans-serif; }
    .cm-attr-card { max-width: 340px; text-align: center; color: var(--muted); display: flex; flex-direction: column; align-items: center; gap: 14px; }
    .cm-attr-ic { color: ${BRAND_ORANGE}; }
    .cm-attr-card h2 { font-family: Georgia, 'Times New Roman', serif; font-weight: 600; font-size: 23px; line-height: 1.3; color: var(--text); margin: 0; }
    .cm-attr-card p { font-size: 14.5px; line-height: 1.55; margin: 0; }
    .cm-attr-by strong { color: var(--text); }
    .cm-attr-card a { color: var(--accent2); text-decoration: none; display: inline-flex; align-items: center; gap: 5px; }
    .cm-attr-card a:hover { text-decoration: underline; }
    .cm-attr-next { background: var(--neutral-bg); color: var(--neutral-text); border: none; border-radius: 10px;
      padding: 10px 26px; font-size: 14px; font-family: inherit; cursor: pointer; margin-top: 8px; }
    .cm-attr-next:hover { filter: brightness(1.06); }

    #cm-brandbar { position: fixed; left: 0; right: 0; display: flex; align-items: center; justify-content: center;
      font-family: system-ui, -apple-system, sans-serif; font-size: 12px; color: var(--muted); pointer-events: none; }
    #cm-brandbar strong { color: var(--text); font-weight: 600; }
    #cm-brandbar a { color: inherit; text-decoration: none; pointer-events: auto; display: inline-flex; align-items: center; gap: 4px; vertical-align: middle; }
    #cm-brandbar a:hover { text-decoration: underline; }

    .cm-connect { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
    .cm-conn-toggle { display: flex; align-items: center; gap: 9px; font-size: 13px; color: var(--text);
      cursor: pointer; background: var(--card); border: 1px solid var(--border2); border-radius: 8px; padding: 11px 12px; }
    .cm-conn-toggle input { width: 15px; height: 15px; }
    .cm-conn-status { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .cm-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
    .cm-dot.on { background: var(--green); box-shadow: 0 0 8px var(--green); }
    .cm-dot.off { background: var(--dim); }
    .cm-conn-p { margin: 0; color: var(--text); font-size: 12.5px; line-height: 1.5; }
    .cm-conn-hint { margin: 0; color: var(--dim); font-size: 11.5px; line-height: 1.5; }
    .cm-cmd { background: var(--field); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
    .cm-cmd code { font-family: ui-monospace, monospace; font-size: 11.5px; color: var(--accent2); white-space: pre; }

    #cm-extglow { position: fixed; inset: 0; pointer-events: none; z-index: 40;
      box-shadow: inset 0 0 0 3px rgba(255,64,64,.95), inset 0 0 46px rgba(255,64,64,.5); animation: cmExtGlow 1.6s ease-in-out infinite; }
    @keyframes cmExtGlow { 0%,100% { opacity: .55 } 50% { opacity: 1 } }
    #cm-extbar { position: fixed; top: 0; left: 0; right: 0; z-index: 42; padding: 8px 16px;
      background: #7a1f1f; color: #ffe9e9; font-family: system-ui, sans-serif; font-size: 12px;
      font-weight: 500; text-align: center; line-height: 1.35; box-shadow: 0 2px 12px rgba(0,0,0,.4); }
    #cm-extbar strong { color: #fff; white-space: nowrap; }
    #cm-extbar .lucide { vertical-align: -2px; margin-right: 3px; }
    #cm-pausebar { position: fixed; top: 0; left: 0; right: 0; z-index: 44; padding: 9px 16px;
      background: #7a1f1f; color: #ffe9e9; font-family: system-ui, sans-serif; font-size: 12.5px; font-weight: 600;
      display: flex; align-items: center; justify-content: center; gap: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.4); }
    .cm-pause-resume { background: #fff; color: #7a1f1f; border: none; border-radius: 7px; padding: 5px 14px; font: 600 12px system-ui, sans-serif; cursor: pointer; }
    .cm-pause-resume:hover { background: #ffe9e9; }
    #cm-handoff { position: fixed; top: 0; left: 0; right: 0; z-index: 45; display: flex; justify-content: center; padding: 10px; }
    .cm-handoff-card { background: var(--head); border: 1px solid var(--accent); border-radius: 12px; padding: 12px 14px; max-width: 360px; width: 100%; box-shadow: 0 10px 30px var(--shadow); }
    .cm-handoff-from { font-size: 12px; color: var(--muted); margin-bottom: 5px; }
    .cm-handoff-from strong { color: var(--text); }
    .cm-handoff-msg { font-size: 13px; color: var(--text); line-height: 1.45; max-height: 120px; overflow-y: auto; margin-bottom: 10px; white-space: pre-wrap; }
    .cm-handoff-btns { display: flex; gap: 7px; }
    .cm-handoff-btns .cm-primary { flex: 1; }
    .cm-handoff-reply, .cm-handoff-dismiss { background: var(--btn); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font: 500 12px system-ui, sans-serif; cursor: pointer; }
    .cm-handoff-reply:hover, .cm-handoff-dismiss:hover { background: var(--btn-hover); }
    #cm-extlock { position: fixed; z-index: 41; background: var(--overlay); backdrop-filter: blur(1.5px);
      display: flex; align-items: flex-start; justify-content: center; padding-top: 16px; }
    #cm-extlock span { display: inline-flex; align-items: center; gap: 7px; background: var(--head); color: #ffb4b4;
      border: 1px solid #7a1f1f; border-radius: 999px; padding: 7px 14px; font-family: system-ui, sans-serif; font-size: 12px; }

    #cm-resumebar { position: fixed; top: 0; left: 0; right: 0; z-index: 43;
      background: var(--accent); color: #fff; font-family: system-ui, sans-serif; font-size: 12px;
      display: flex; flex-direction: column; box-shadow: 0 2px 12px rgba(0,0,0,.35); }
    #cm-resumebar .cm-resume-top { display: flex; align-items: center; justify-content: center; gap: 5px; padding: 8px 12px; }
    #cm-resumebar strong { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
    #cm-resumebar .cm-resume-label { display: inline-flex; align-items: center; gap: 5px; opacity: .95; white-space: nowrap; }
    #cm-resumebar .cm-resume-exp, #cm-resumebar .cm-resume-x { background: rgba(255,255,255,.18); border: none; color: #fff; border-radius: 6px;
      padding: 3px; cursor: pointer; display: inline-flex; }
    #cm-resumebar .cm-resume-exp { margin-left: 8px; }
    #cm-resumebar .cm-resume-x { margin-left: 4px; }
    #cm-resumebar .cm-resume-exp:hover, #cm-resumebar .cm-resume-x:hover { background: rgba(255,255,255,.32); }
    #cm-resumebar .cm-resume-exp.on { background: rgba(255,255,255,.4); }
    #cm-resumebar .cm-resume-x.confirm { background: #fff; color: var(--accent); }
    #cm-resumebar .cm-resume-tr { max-height: min(50vh, 340px); overflow-y: auto; background: var(--bg); color: var(--text);
      padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; border-top: 1px solid rgba(255,255,255,.3); }
    .cm-day-sep { align-self: center; font-size: 10.5px; color: var(--dim); background: var(--field); border-radius: 10px; padding: 2px 10px; margin: 2px 0; }
    /* Overlay de continuação visual (Eixo B): cobre a área de mensagens, bolhas estilo chat, scroll natural. */
    #cm-resume-overlay { position: fixed; z-index: 20; background: var(--bg); color: var(--text); overflow-y: auto; overscroll-behavior: contain;
      display: flex; flex-direction: column; gap: 14px; padding: 16px 14px 22px; box-sizing: border-box; }
    #cm-resume-overlay .cm-ov-msg { max-width: 88%; display: flex; flex-direction: column; gap: 3px; }
    #cm-resume-overlay .cm-ov-msg.user { align-self: flex-end; align-items: flex-end; }
    #cm-resume-overlay .cm-ov-msg.asst { align-self: flex-start; }
    #cm-resume-overlay .cm-ov-time { font-size: 10px; color: var(--dim); padding: 0 2px; }
    #cm-resume-overlay .cm-ov-bubble { font: 13.5px/1.55 system-ui, -apple-system, sans-serif; white-space: pre-wrap; word-break: break-word; border-radius: 14px; padding: 9px 13px; }
    #cm-resume-overlay .cm-ov-msg.user .cm-ov-bubble { background: var(--field); }
    #cm-resume-overlay .cm-ov-msg.asst .cm-ov-bubble { background: transparent; padding: 2px 0; }
    #cm-resume-overlay .cm-ov-day { align-self: center; font-size: 10.5px; color: var(--dim); background: var(--field); border-radius: 10px; padding: 3px 11px; }
    #cm-resume-overlay .cm-ov-hint { align-self: center; font-size: 11px; color: var(--dim); padding: 6px 4px 2px; opacity: .8; }
    #cm-resume-overlay .cm-ov-datehdr { position: sticky; top: 6px; align-self: center; z-index: 3; margin-bottom: -26px; opacity: 0; transition: opacity .25s; pointer-events: none;
      font-size: 10.5px; color: var(--dim); background: var(--field); border-radius: 11px; padding: 3px 12px; box-shadow: 0 1px 7px rgba(0,0,0,.22); }
    #cm-resume-overlay .cm-ov-datehdr.show { opacity: 1; }
    #cm-resumebar .cm-resume-rename { font: 600 12px system-ui, sans-serif; color: #fff; background: rgba(255,255,255,.2); border: 1px solid rgba(255,255,255,.45); border-radius: 6px; padding: 2px 7px; max-width: 52%; outline: none; }
    /* Aviso de nova versão (card no topo da tela de memória) */
    .cm-update-card { background: rgba(120,103,253,.14); border: 1px solid rgba(120,103,253,.42); border-radius: 10px; padding: 11px 12px; margin-bottom: 10px; }
    .cm-update-title { font-size: 12.5px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
    .cm-update-actions { display: flex; gap: 8px; }
    .cm-update-card button { flex: 1; border-radius: 7px; padding: 7px 8px; font: 600 12px system-ui, sans-serif; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 5px; border: 1px solid var(--border); }
    .cm-update-gh { background: var(--field); color: var(--text); }
    .cm-update-now { background: var(--accent); color: #fff; border-color: var(--accent); }
    .cm-update-now:disabled { opacity: .6; cursor: default; }
    .cm-update-err { font-size: 11px; color: #ff6b6b; margin-top: 7px; }
    .cm-check-update { display: inline-flex; align-items: center; gap: 5px; margin: 4px auto 0; padding: 4px 6px; background: none; border: none; color: var(--text); opacity: .5; font: 500 11.5px system-ui, sans-serif; cursor: pointer; }
    .cm-check-update:hover { opacity: .85; text-decoration: underline; }
    #cm-copy.cm-copied { background: #1f9d55 !important; border-color: #1f9d55 !important; color: #fff !important; }

    #toast { position: fixed; bottom: 72px; right: 18px; max-width: 320px; background: var(--head); color: var(--text);
      padding: 10px 14px; border-radius: 8px; box-shadow: 0 6px 20px var(--shadow); font-family: system-ui, sans-serif; font-size: 12px;
      opacity: 0; transform: translateY(8px); pointer-events: none; transition: all .2s; border-left: 3px solid var(--accent); z-index: 10; }
    #toast.show { opacity: 1; transform: translateY(0); }
    #toast.err { border-left-color: #ff6b6b; }

    /* Segurança & Cofre */
    #cm-screen-security, #cm-screen-vault { padding: 14px 16px; gap: 12px; overflow-y: auto; }
    .cm-conn-nav { display: flex; gap: 8px; margin-top: 4px; }
    .cm-secbtn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      background: var(--btn); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 9px; cursor: pointer; font-size: 12.5px; }
    .cm-secbtn:hover { background: var(--btn-hover); }
    .cm-addrow { display: flex; gap: 8px; }
    #cm-screen-security input, .cm-vaultform input { background: var(--field); border: 1px solid var(--border); color: var(--text);
      border-radius: 8px; padding: 9px 11px; font-size: 12.5px; font-family: inherit; width: 100%; }
    #cm-screen-security input:focus, .cm-vaultform input:focus { outline: none; border-color: var(--accent); }
    .cm-addrow .cm-primary { flex: none; width: 42px; padding: 0; }
    #cm-allowlist { display: flex; flex-direction: column; gap: 6px; }
    .cm-allowrow { display: flex; align-items: center; justify-content: space-between; gap: 8px;
      background: var(--card); border: 1px solid var(--border-card); border-radius: 8px; padding: 8px 10px; }
    .cm-allowname { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--text); }
    .cm-allowname .lucide { color: var(--muted); }
    .cm-seclog-head { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; color: var(--muted); font-size: 12px; }
    #cm-actionlog { display: flex; flex-direction: column; gap: 5px; max-height: 240px; overflow-y: auto; }
    .cm-logrow { background: var(--card); border: 1px solid var(--border-card); border-left: 3px solid var(--green); border-radius: 7px; padding: 6px 9px; }
    .cm-logrow.warn { border-left-color: #e0a53a; }
    .cm-logrow.err { border-left-color: #ff6b6b; }
    .cm-logtop { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .cm-logcmd { font-weight: 600; color: var(--text); flex: none; }
    .cm-loghost { color: var(--muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cm-logtime { color: var(--faint); font-size: 10.5px; flex: none; }
    .cm-logsub { color: var(--dim); font-size: 11px; margin-top: 2px; word-break: break-word; }
    .cm-vaultform { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border); padding-top: 12px; }
    #cm-vaultlist { display: flex; flex-direction: column; gap: 6px; }
    .cm-credrow { display: flex; align-items: center; gap: 10px; background: var(--card); border: 1px solid var(--border-card); border-radius: 9px; padding: 9px 11px; }
    .cm-credmid { flex: 1; min-width: 0; }
    .cm-credname { font-size: 13px; color: var(--text); font-weight: 500; }
    .cm-credsub { font-size: 11px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Consentimento inline */
    #cm-consent { position: fixed; inset: 0; z-index: 60; background: var(--overlay); backdrop-filter: blur(2px);
      display: flex; align-items: center; justify-content: center; padding: 20px; }
    .cm-consent-card { background: var(--head); border: 1px solid var(--border2); border-radius: 14px; padding: 20px;
      max-width: 320px; text-align: center; box-shadow: 0 16px 44px var(--shadow); }
    .cm-consent-ic { color: var(--accent); display: flex; justify-content: center; margin-bottom: 6px; }
    .cm-consent-card h3 { margin: 0 0 8px; font-size: 15px; color: var(--text); }
    .cm-consent-line { margin: 0 0 16px; font-size: 12.5px; color: var(--muted); line-height: 1.5; }
    .cm-consent-line strong { color: var(--text); }
    .cm-consent-btns { display: flex; flex-direction: column; gap: 8px; }
    .cm-consent-btns button { padding: 9px; border-radius: 8px; cursor: pointer; font-size: 12.5px; font-family: inherit; }
    .cm-consent-sess { background: var(--btn); color: var(--text); border: 1px solid var(--border); }
    .cm-consent-sess:hover { background: var(--btn-hover); }
    .cm-consent-deny { background: none; color: var(--danger); border: 1px solid var(--danger-border); }
  `;

  if (globalThis.__CM_TEST) globalThis.__cmTest = { startResume, cancelResume };

  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
