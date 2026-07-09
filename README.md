# Claudão²

Fork da extensão **Claude in Chrome** (Anthropic) com duas camadas próprias:

1. **Memória persistente e autônoma** — o Claude lê, cria e edita os próprios documentos de contexto (markdown), guardados só neste navegador. Não recomeça do zero a cada conversa.
2. **Ponte MCP** — dá ao **Claude do VS Code / Cursor / Windsurf** olhos e mãos nas páginas abertas no navegador (ler DOM/console/rede, screenshot de aba em segundo plano, clicar, preencher, logar, navegar), tudo local e com controle de permissões.

> Versão modificada de uso próprio, construída sobre a extensão oficial da Anthropic, com o disclaimer original mantido.

---

## Instalar a extensão

1. Baixe/clone este repositório e **descompacte** numa pasta.
2. Abra `chrome://extensions`, ligue o **Modo do desenvolvedor** (canto superior direito).
3. **Desinstale a extensão oficial "Claude in Chrome"** se estiver instalada. (Esta usa o mesmo ID oficial para preservar o login, e duas extensões com o mesmo ID não coexistem.)
4. Clique em **"Carregar sem compactação"** e selecione a pasta descompactada.

Pronto: o painel do Claudão² e a memória já funcionam. A memória começa com um template genérico que você edita (pelo painel ou pelo editor) — o Claude também vai preenchendo sozinho.

## Ligar a ponte com o VS Code (opcional)

Para o Claude do seu editor agir no navegador:

```bash
node bridge/install.mjs
```

Rode isso **de dentro da pasta da extensão**. Ele registra o MCP no Claude Code, Cursor, VS Code e Windsurf de uma vez. O servidor sobe sozinho quando o Claude precisa (sem dependências, sem `npm install`). Detalhes em [`bridge/README.md`](bridge/README.md).

A integração vem **ligada por padrão** e a extensão conecta sozinha — você não precisa abrir nada. Para ver o status/comando exato: botão 🧠 no topo do painel → ícone de tomada.

## Segurança (padrões)

- **Auto-aprovação ligada por padrão**: o Claude externo age em qualquer site sem pedir. Em **Segurança** dá para desligar e exigir aprovação por domínio.
- **Cofre de credenciais cifrado** (chave que não sai do dispositivo): o Claude externo referencia por apelido e nunca vê o valor.
- **Log de ações** e **kill switch** no painel.

> Para distribuir a terceiros, o padrão saudável é **desligar a auto-aprovação** (exigir allowlist/consentimento).

---

*Claude in Chrome é uma extensão da Anthropic. Claudão² é uma modificação independente, sem vínculo oficial.*
