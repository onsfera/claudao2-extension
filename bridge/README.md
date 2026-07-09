# Claudão² Bridge — MCP para depurar páginas (embutido, zero dependência)

Deixa o **Claude do VS Code** (ou Cursor/Windsurf) ver e agir nas páginas abertas no
Chrome pela extensão Claudão² — inclusive **abas em segundo plano**, sem trazê-las para
frente.

```
Claude do VS Code  ──stdio──►  mcp-server.mjs  ──WebSocket──►  Claudão² (service worker)  ──►  páginas
```

Este servidor é **um único arquivo, sem `npm install`** (o WebSocket é implementado na
mão). Vem embutido na extensão, em `bridge/mcp-server.mjs`.

### Várias instâncias de editor ao mesmo tempo

Cada VS Code/Cursor sobe o seu próprio `mcp-server`. Para não brigarem pela porta, eles se
auto-organizam: **o primeiro a subir vira o HUB** (dono da porta `8765` e quem fala com a
extensão); os **demais viram clientes do hub** e encaminham seus comandos por ele. A
extensão fica conectada a um único hub e atende todos os editores. Se o hub cair (você
fechou aquele editor), **um cliente assume a porta sozinho** em segundos e a extensão
reconecta. Nada pra configurar.

## Ferramentas (38)

**Percepção:** `browser_tabs`, `browser_read` (text/html/markdown/a11y), `browser_query` (elementos estruturados), `browser_snapshot` (mapa interativo com refs estáveis), `browser_get_state` (url/título/viewport/cookies), `browser_console` (filtro por nível), `browser_network` (fetch/XHR capturados), `browser_eval` (JS via debugger), `browser_screenshot` (viewport/elemento/fullPage), `browser_wait` (elemento/url/tempo).

**Ação (com cursor vermelho animado):** `browser_click` (selector/ref/texto; `real:true` = eventos de mouse via CDP), `browser_fill`, `browser_type` (tecla a tecla), `browser_press`, `browser_hover`, `browser_scroll`, `browser_select`, `browser_submit`, `browser_move_cursor`, `browser_drag`, `browser_upload` (arquivo local direto no `<input type=file>`), `browser_navigate` (in-place; `newTab:true` ou `file:`/`data:`/`blob:` abrem em nova aba sem perder a página de trabalho), `browser_history` (back/forward/reload; `hard:true` = ignora o cache, Ctrl+Shift+R).

**Multi-aba:** `browser_open_tab` (nova aba, `active:false` = segundo plano), `browser_close_tab`, `browser_activate_tab`.

**Login seguro e frictionless:** `browser_login` (detecta o form e loga sozinho), `browser_fill_secret`. Passe a senha direto, `credentialEnv` (o **server** resolve do ambiente — o segredo **não passa pelo modelo**) ou `credentialRef` (a **extensão** resolve do cofre local — o modelo só usa o nome). Segredos **não são logados**, **não são ecoados** e são **redigidos** em leituras posteriores.

**Cofre:** `browser_credentials_list` (só nomes/domínios/usuários, **nunca** o valor), `browser_credentials_save`, `browser_credentials_delete`. Guardado cifrado só na máquina do usuário; referenciado por `credentialRef` em login/fill_secret.

**Manutenção (dev):** `browser_reload_extension` — recarrega a própria extensão (relê o código do disco em modo descompactado, sem abrir `chrome://extensions`). Gated pela opção *Segurança → "Permitir recarregar a extensão"*. Não recarrega o mcp-server do editor.

**Memória:** `memory_list`, `memory_read`, `memory_search`, `memory_append`, `memory_write`, `memory_delete`.

> **Regra de abas:** ações continuam na aba de trabalho (por `tabId`); páginas/recursos auxiliares vão para nova aba (`newTab`/`open_tab`, ou automático em arquivos locais). Comandos na mesma aba serializam; abas diferentes rodam em paralelo.

### Conexão automática (sem abrir a extensão)
A integração vem **ligada por padrão**: o service worker conecta sozinho ao hub, e o hub
manda um *keepalive* que mantém a extensão acordada enquanto o VS Code está de pé. Você
**não precisa abrir nada** — é só o hub estar de pé (o Claude sobe sozinho quando precisa).
Dá pra desligar em: botão 🧠 → ícone de tomada.

### Segurança (auto-aprovação, allowlist, consentimento, log)
- **Auto-aprovação LIGADA por padrão**: as ações rodam em qualquer site sem pedir (é a sua
  máquina, é local). Desligue em **Segurança** para exigir aprovação por domínio.
- Com a auto-aprovação **desligada**: ações só rodam em **domínios aprovados** (`localhost`/
  `127.0.0.1` já liberados); site novo → a extensão **pede aprovação** (card: *permitir sempre
  / só nesta sessão / recusar*). Percepção (ler, console, screenshot) é sempre livre.
- **Log de ações** visível no painel (o que o Claude externo fez, quando, em qual aba) — sem segredos.
- **Permitir recarregar a extensão** (ligado por padrão): habilita `browser_reload_extension`. Desligue para bloquear o auto-reload pelo Claude externo.
- Gerencie tudo em: botão 🧠 → ícone de tomada → **Segurança** / **Cofre**.

> **Distribuição:** para uso próprio os padrões são frictionless (auto-aprovação e auto-reload ligados). Para distribuir a terceiros, o padrão saudável é desligar **auto-aprovação** (exigir allowlist/consentimento) e avaliar **auto-reload** conforme a confiança no ambiente.

Sem `tabId` → aba ativa. Com `tabId` (de `browser_tabs`) → funciona em abas de fundo. Use `browser_snapshot` para pegar `ref`s estáveis e clicar/preencher sem seletores frágeis.

### Login sem segredo no modelo (`credentialEnv`)
```
# no ambiente do editor/projeto:
export MEU_APP_ADMIN_PASSWORD='...'
# o Claude externo chama:
browser_login { username: "admin@exemplo.com", credentialEnv: "MEU_APP_ADMIN_PASSWORD" }
# o MCP server resolve o valor localmente; o modelo nunca vê a senha.
```

## Setup (uma vez)

No VS Code, na pasta do seu projeto:

```bash
claude mcp add claudao2 -- node "<CAMINHO-DA-EXTENSÃO>/bridge/mcp-server.mjs"
```

Substitua `<CAMINHO-DA-EXTENSÃO>` pela pasta onde a extensão está carregada (a mesma que
você selecionou em `chrome://extensions` → "Carregar sem compactação"). O comando exato,
já com o caminho, aparece na extensão: botão 🧠 → ícone de tomada (Conectar VS Code) →
"Copiar comando". Ali também tem o **status da conexão** ao vivo.

O servidor sobe sozinho quando o Claude precisa — você não roda nada à mão.

## Enquanto o Claude externo age

- A página em foco ganha um **glow vermelho** (igual ao indicador nativo da extensão).
- No painel lateral aparece **"Extensão em interação com o Claude externo — <app>"** e o
  campo de enviar prompt fica **travado**, para você não atropelar a sessão. Some sozinho
  poucos segundos após o Claude externo parar.

## Segurança

- O hub escuta só em `127.0.0.1` e só aceita conexões com origin `chrome-extension://`.
- `browser_eval` roda JS arbitrário na página (poder de DevTools). Use em páginas suas / de dev.

## Config

- Porta: env `CLAUDAO_BRIDGE_PORT` (padrão `8765`). Se mudar, ajuste `WS_URL` em
  `memory/bridge-sw.js`.
