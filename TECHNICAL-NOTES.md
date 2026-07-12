# Technical Notes / Notas Técnicas — Claudão²

> An independent, unofficial fork of Anthropic's **Claude in Chrome** extension, with two extra layers: persistent autonomous memory and an MCP bridge that gives editor-side Claude (VS Code, Cursor, Windsurf) real eyes and hands on the browser.
>
> Fork independente e não oficial da extensão **Claude in Chrome** (Anthropic), com duas camadas próprias: memória persistente autônoma e uma ponte MCP que dá ao Claude do editor (VS Code, Cursor, Windsurf) olhos e mãos de verdade no navegador.

---

## English

### What it is
Two capabilities layered on top of the official extension, keeping the original login and disclaimer intact:

1. **Persistent, autonomous memory.** Claude reads, writes, and edits its own context documents (markdown, stored only in this browser). It does not restart from zero each conversation. Retrieval is relevance-scored (pinned core plus top-K relevant chunks), so memory scales without bloating context.
2. **MCP bridge.** Editor-side Claude perceives and acts on open pages: read DOM/console/network, screenshot a background tab without stealing focus, click, fill, type, log in, navigate. Everything is local and permission-gated.

### Architecture
- **MV3 service worker** hosts the bridge (`memory/bridge-sw.js`). One worker per Chrome profile means one bridge, regardless of how many panels or tabs are open.
- **Zero-dependency MCP server** (`bridge/mcp-server.mjs`): a stdio JSON-RPC server plus a hand-rolled RFC6455 WebSocket hub on `127.0.0.1:8765`. No `npm install`, no build step.
- **Single-hub election.** The first editor to bind the port becomes the hub and talks to the extension; other editors connect as clients through it (`X-Claudao-Role: editor`, masked frames). If the hub dies, a client is promoted in seconds and the extension reconnects on its own.
- **CDP for the hard parts.** Screenshots (`Page.captureScreenshot`), trusted mouse input, file upload (`DOM.setFileInputFiles`), and layout metrics go through `chrome.debugger`. DOM perception and most actions run through `chrome.scripting` in the page, so they do not raise the debugger bar.
- **Dynamic install path.** The server self-locates and announces its real path to the extension over `server_hello`, so the setup command shown in the panel is correct on any machine.

### Capability surface (42 MCP tools)
- **Perception:** tabs, read (text/html/markdown/a11y), query, snapshot (stable `ref` ids), get_state, console, network (fetch and XHR capture), inspect, observe (DOM mutation diff), screenshot (viewport, element, or full page, JPEG downscale by default).
- **Set-of-marks perception:** `browser_look` overlays numbered marks on interactive elements (including Google web components like `cfc-select` and `mat-select`) so the model can point at a number instead of guessing selectors.
- **Action:** click (with occlusion warning and the actual target reported back), fill, fill_secret, type, press, hover, scroll, select (atomic open-and-choose for custom dropdowns), submit, navigate, drag, move_cursor, upload.
- **Multi-tab:** open_tab, close_tab, activate_tab, all coordinated by `tabId` (context routing by page URL).
- **Auth without setup:** login auto-detects the form and submits; secrets are never logged, never echoed, and redacted from later reads.
- **Memory:** list, read, search, append, write, delete.
- **Handoff:** editor-side Claude and browser-side Claude pass tasks to each other through shared storage.

### Engineering highlights
- **A visible agent cursor.** Clicks and fills animate a red cursor that scrolls to the element, moves with easing, and ripples before acting, so the user sees the action happen.
- **Granular per-tab control.** Pausing one page (a floating "Pause this agent" button, localized pt/en/es) pauses only that page. A second agent on another tab keeps working. Takeover is detected: if the user grabs the mouse or keyboard while the agent is active, that tab pauses on its own.
- **Real-world text input.** Typing dispatches genuine key events per character (so LinkedIn-style mention typeaheads fire) and handles `contenteditable` editors like Quill without corrupting their internal model. Restricted inputs (number, date, time) are set whole to avoid sanitization loss.
- **Robust file upload.** Uploads go straight to the `<input type=file>` by path over CDP, walking shadow DOM and iframes, and the native OS file dialog is suppressed when the agent (not the user) drives the click, so nothing hangs.
- **SPA resilience.** Element refs survive re-renders (re-resolved by label and role, invalidated on navigation). Non-scriptable pages (Web Store, `chrome://`) are detected and reported clearly instead of failing three times.
- **Timeouts everywhere.** Every CDP call that can hang is bounded, so a stalled renderer never leaves the debugger attached or deadlocks the per-tab command queue.

### Security model
- **Device-bound credential vault.** A non-extractable AES-GCM key lives in the extension's IndexedDB. The model references a credential by nickname and never sees the value.
- **Secret redaction.** Values used in login/fill_secret are masked in every later textual return.
- **PII redaction (opt-in).** Screenshots can black-box sensitive fields (password, email, card, CPF). If the redaction cannot be computed, the capture fails closed rather than leaking.
- **Allowlist and consent (opt-out).** Actions can be gated per domain, with an action log and a kill switch. The frictionless default (auto-approve) is meant for the local owner. For third-party distribution, turn auto-approve off.

### Quality process
Changes are validated with `node --check`, a suite of over 100 regression and unit checks, and adversarial-review workflows: independent agents try to refute each finding before it is accepted. A recent real-world batch (an editor scheduling posts on LinkedIn) went through three review rounds that surfaced 15 real bugs, then 4 regressions introduced by the fixes themselves, all resolved.

### Install
See [`README.md`](README.md). Short version: load unpacked in `chrome://extensions`, then `node bridge/install.mjs` from the extension folder to register the MCP with Claude Code, Cursor, VS Code, and Windsurf at once.

---

## Português

### O que é
Duas capacidades sobre a extensão oficial, mantendo o login e o disclaimer originais:

1. **Memória persistente e autônoma.** O Claude lê, cria e edita os próprios documentos de contexto (markdown, guardados só neste navegador). Não recomeça do zero a cada conversa. A recuperação é por relevância (núcleo fixo mais os trechos mais relevantes), então a memória escala sem inchar o contexto.
2. **Ponte MCP.** O Claude do editor percebe e age nas páginas abertas: ler DOM/console/rede, tirar screenshot de aba em segundo plano sem roubar o foco, clicar, preencher, digitar, logar, navegar. Tudo local e com controle de permissões.

### Arquitetura
- **Service worker MV3** hospeda a ponte (`memory/bridge-sw.js`). Um worker por perfil do Chrome significa uma ponte, não importa quantos painéis ou abas estejam abertos.
- **Servidor MCP sem dependências** (`bridge/mcp-server.mjs`): JSON-RPC por stdio mais um hub WebSocket RFC6455 escrito na mão em `127.0.0.1:8765`. Sem `npm install`, sem build.
- **Hub único por eleição.** O primeiro editor a segurar a porta vira o hub e fala com a extensão; os outros conectam como clientes através dele (`X-Claudao-Role: editor`, frames mascarados). Se o hub cai, um cliente assume em segundos e a extensão reconecta sozinha.
- **CDP para o que é difícil.** Screenshots (`Page.captureScreenshot`), cliques reais (isTrusted), upload de arquivo (`DOM.setFileInputFiles`) e métricas de layout passam pelo `chrome.debugger`. A percepção de DOM e a maioria das ações rodam via `chrome.scripting` na página, sem levantar a barra de depuração.
- **Caminho de instalação dinâmico.** O servidor se auto-localiza e informa o caminho real à extensão via `server_hello`, então o comando de setup mostrado no painel está certo em qualquer máquina.

### Superfície de capacidades (42 tools MCP)
- **Percepção:** abas, read (texto/html/markdown/a11y), query, snapshot (ids `ref` estáveis), get_state, console, rede (captura fetch e XHR), inspect, observe (diff de mutação do DOM), screenshot (viewport, elemento ou página inteira, JPEG com downscale por padrão).
- **Set-of-marks:** o `browser_look` sobrepõe marcas numeradas nos elementos interativos (inclusive web components do Google como `cfc-select` e `mat-select`), então o modelo aponta um número em vez de adivinhar seletores.
- **Ação:** click (com aviso de oclusão e o alvo real reportado de volta), fill, fill_secret, type, press, hover, scroll, select (abre e escolhe de forma atômica em dropdowns customizados), submit, navigate, drag, move_cursor, upload.
- **Multi-aba:** open_tab, close_tab, activate_tab, coordenados por `tabId` (roteamento por contexto da URL).
- **Login sem setup:** detecta o formulário e submete; o segredo nunca é logado, nunca é ecoado, e é redigido em leituras posteriores.
- **Memória:** list, read, search, append, write, delete.
- **Handoff:** o Claude do editor e o do navegador passam tarefas um pro outro pela memória compartilhada.

### Destaques de engenharia
- **Cursor de agente visível.** Clique e preenchimento animam um cursor vermelho que rola até o elemento, se move com transição e dá um ripple antes de agir, então o usuário vê a ação acontecer.
- **Controle granular por aba.** Pausar uma página (botão flutuante "Pausar esse agente", localizado pt/en/es) pausa só aquela página. Um segundo agente em outra aba segue trabalhando. Assumir é detectado: se o usuário pega o mouse ou o teclado com o agente ativo, aquela aba pausa sozinha.
- **Digitação de mundo real.** A digitação dispara eventos de teclado reais por caractere (então typeaheads de menção estilo LinkedIn funcionam) e lida com editores `contenteditable` como o Quill sem corromper o model interno. Campos restritos (number, date, time) são setados inteiros para não perder valor na sanitização.
- **Upload robusto.** O arquivo vai direto pro `<input type=file>` por caminho via CDP, atravessando shadow DOM e iframes, e o diálogo nativo do sistema é suprimido quando é o agente (não o usuário) que dispara o clique, então nada trava.
- **Resiliência em SPA.** Os refs de elemento sobrevivem a re-renders (re-resolvidos por rótulo e role, invalidados na navegação). Páginas não-scriptáveis (Web Store, `chrome://`) são detectadas e reportadas com clareza em vez de falhar três vezes.
- **Timeout em tudo.** Toda chamada CDP que pode travar é limitada, então um renderer pendurado nunca deixa o debugger preso nem trava a fila de comandos da aba.

### Modelo de segurança
- **Cofre de credenciais device-bound.** Uma chave AES-GCM não-exportável vive no IndexedDB da extensão. O modelo referencia a credencial por apelido e nunca vê o valor.
- **Redação de segredos.** Valores usados em login/fill_secret são mascarados em todo retorno textual posterior.
- **Redação de PII (opt-in).** Screenshots podem borrar campos sensíveis (senha, email, cartão, CPF). Se a redação não pode ser computada, a captura falha fechada em vez de vazar.
- **Allowlist e consentimento (opt-out).** Ações podem ser gateadas por domínio, com log de ações e kill switch. O padrão sem fricção (auto-aprovação) é para o dono local. Para distribuir a terceiros, desligue a auto-aprovação.

### Processo de qualidade
As mudanças são validadas com `node --check`, uma suíte de mais de 100 checagens de regressão e unidade, e workflows de revisão adversarial: agentes independentes tentam refutar cada achado antes de aceitá-lo. Uma leva recente de uso real (um editor agendando posts no LinkedIn) passou por três rodadas de revisão que revelaram 15 bugs reais e depois 4 regressões introduzidas pelas próprias correções, todas resolvidas.

### Instalar
Veja o [`README.md`](README.md). Resumo: carregue sem compactação em `chrome://extensions`, depois `node bridge/install.mjs` de dentro da pasta da extensão para registrar o MCP no Claude Code, Cursor, VS Code e Windsurf de uma vez.

---

*Claude in Chrome is an Anthropic extension. Claudão² is an independent modification with no official affiliation. / Claude in Chrome é uma extensão da Anthropic. Claudão² é uma modificação independente, sem vínculo oficial.*
