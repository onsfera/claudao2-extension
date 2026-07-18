/*
 * Claude Memory - núcleo de persistência (v2, multi-documento)
 * ------------------------------------------------------------
 * Camada ADITIVA sobre a extensão oficial "Claude in Chrome".
 * A memória é um conjunto de documentos markdown ("pasta de .md") guardado em
 * chrome.storage.local (persiste entre reaberturas; a extensão já tem "storage"
 * e "unlimitedStorage"). Não toca em nenhum bundle da extensão.
 *
 * Por que storage e não a pasta da extensão: uma extensão Chrome é read-only em
 * runtime, não pode gravar dentro da própria pasta instalada. Os arquivos reais
 * em memory/seed/*.md são o TEMPLATE inicial (semente), copiados para a memória
 * viva no primeiro uso. A partir daí o Claude edita a cópia em storage.
 *
 * Expõe globalThis.ClaudeMemory. Funciona no painel lateral (script de página)
 * e nos tabs do claude.ai (content script).
 */
(function () {
  "use strict";

  if (globalThis.ClaudeMemory) return;

  const KEY = "cm_memory_v1";
  const MARKERS_KEY = "cm_saved_markers_v1";
  const DEFAULT_TARGET = "memoria-viva.md";

  // Sementes empacotadas (arquivos reais em memory/seed/). pinned = injetado no
  // contexto por padrão. Docs grandes/situacionais ficam pinned:false.
  // pinned:true  = núcleo, sempre injetado inteiro (mantenha pequeno).
  // pinned:false = pool de recuperação: entra por relevância à mensagem atual.
  const SEED_FILES = [
    { name: "perfil.md", pinned: true },
    { name: "regras-inviolaveis.md", pinned: true },
    { name: "como-trabalhar.md", pinned: true },
    { name: "negocios.md", pinned: false },
    { name: "voz-e-estilo.md", pinned: false },
    { name: "memoria-viva.md", pinned: false },
  ];

  const DEFAULT_SETTINGS = { autoInject: true, autoCapture: true };

  function now() {
    return new Date().toISOString();
  }
  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  // --- Texto: tokenização, stopwords, similaridade, chunking (p/ retrieval) ---
  const STOP = new Set(
    ("a o e de da do das dos que em um uma para por com no na nos nas se ao aos à às " +
      "as os ou como mas quando onde qual quais é são foi ser sua seu suas seus meu minha " +
      "meus minhas ele ela eles elas isso este esta esse essa isto aquilo já não sim " +
      "the of and to in for on with at is are was be as or an it this that").split(/\s+/)
  );
  function tokenize(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "") // remove acentos
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t));
  }
  // assinatura normalizada (conjunto de termos ordenados) p/ dedup
  function normSig(s) {
    const t = Array.from(new Set(tokenize(s))).sort();
    return t.join(" ");
  }
  // Coeficiente de Dice: 2·|A∩B| / (|A|+|B|). Tolerante a reformulação
  // ("30 minutos" vs "30 min") sem disparar em fatos curtos distintos.
  function dice(aStr, bStr) {
    const a = new Set(aStr.split(" ").filter(Boolean));
    const b = new Set(bStr.split(" ").filter(Boolean));
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return (2 * inter) / (a.size + b.size);
  }
  function stripEntryPrefix(line) {
    return String(line || "").replace(/^\s*[-*]\s*\(\d{4}-\d{2}-\d{2}\)\s*/, "");
  }
  // quebra o conteúdo de um doc em "chunks" (parágrafos/bullets), com heading de contexto
  function chunkContent(content) {
    const lines = String(content || "").split("\n");
    const chunks = [];
    let heading = "";
    let para = [];
    const flush = () => {
      const text = para.join("\n").trim();
      if (text) chunks.push({ heading, text });
      para = [];
    };
    for (const raw of lines) {
      const l = raw.replace(/\s+$/, "");
      if (/^#{1,6}\s/.test(l)) { flush(); heading = l.replace(/^#{1,6}\s/, "").trim(); continue; }
      if (/^\s*[-*]\s+/.test(l)) { flush(); chunks.push({ heading, text: l.trim() }); continue; } // bullet = chunk próprio
      if (l.trim() === "") { flush(); continue; }
      para.push(l);
    }
    flush();
    return chunks;
  }

  async function readRaw() {
    const out = await chrome.storage.local.get(KEY);
    return out ? out[KEY] : null;
  }

  async function persist(mem) {
    mem.version = 2;
    mem.updatedAt = now();
    await chrome.storage.local.set({ [KEY]: mem });
    return mem;
  }

  function normalize(mem) {
    return {
      version: 2,
      updatedAt: mem.updatedAt || null,
      docs: Array.isArray(mem.docs) ? mem.docs : [],
      settings: { ...DEFAULT_SETTINGS, ...(mem.settings || {}) },
    };
  }

  // Carrega as sementes reais de memory/seed/*.md para dentro do storage.
  async function buildFromSeeds() {
    const docs = [];
    for (const s of SEED_FILES) {
      let content = "";
      try {
        const resp = await fetch(chrome.runtime.getURL("memory/seed/" + s.name));
        content = await resp.text();
      } catch (e) {
        content = "# " + s.name + "\n\n(não foi possível carregar a semente)";
      }
      docs.push({
        name: s.name,
        content,
        pinned: !!s.pinned,
        createdAt: now(),
        updatedAt: now(),
      });
    }
    return { version: 2, updatedAt: now(), docs, settings: { ...DEFAULT_SETTINGS } };
  }

  // Migra dados v1 (profile/entries) para o modelo de docs, se existirem.
  function migrateV1(old) {
    const docs = [];
    if (old.profile) {
      docs.push({ name: "perfil.md", content: old.profile, pinned: true, createdAt: now(), updatedAt: now() });
    }
    if (Array.isArray(old.entries) && old.entries.length) {
      const body =
        "# Memória viva\n\n## Registros\n" +
        old.entries.map((e) => `- ${e.text}`).join("\n");
      docs.push({ name: DEFAULT_TARGET, content: body, pinned: true, createdAt: now(), updatedAt: now() });
    }
    return { version: 2, updatedAt: now(), docs, settings: { ...DEFAULT_SETTINGS, ...(old.settings || {}) } };
  }

  let seedingPromise = null;
  async function ensureLoaded() {
    const existing = await readRaw();
    if (existing && Array.isArray(existing.docs) && existing.docs.length) {
      return normalize(existing);
    }
    if (existing && existing.version === 1 && (existing.profile || existing.entries)) {
      return persist(migrateV1(existing)).then(normalize);
    }
    // primeira vez: semeia (protege contra corrida entre contextos)
    if (!seedingPromise) {
      seedingPromise = buildFromSeeds().then((mem) => persist(mem));
    }
    return seedingPromise.then(normalize);
  }

  function findDoc(mem, name) {
    return mem.docs.find((d) => d.name.toLowerCase() === String(name).toLowerCase());
  }

  const ClaudeMemory = {
    KEY,
    DEFAULT_TARGET,

    async load() {
      return ensureLoaded();
    },

    async getDocs() {
      return (await ensureLoaded()).docs;
    },

    async getDoc(name) {
      return findDoc(await ensureLoaded(), name) || null;
    },

    /** Cria ou substitui o conteúdo de um documento. */
    async upsertDoc(name, content, pinned) {
      const mem = await ensureLoaded();
      const doc = findDoc(mem, name);
      if (doc) {
        doc.content = String(content ?? "");
        if (pinned !== undefined) doc.pinned = !!pinned;
        doc.updatedAt = now();
      } else {
        mem.docs.push({
          name: String(name),
          content: String(content ?? ""),
          pinned: pinned === undefined ? true : !!pinned,
          createdAt: now(),
          updatedAt: now(),
        });
      }
      return persist(mem);
    },

    async setPinned(name, pinned) {
      const mem = await ensureLoaded();
      const doc = findDoc(mem, name);
      if (doc) {
        doc.pinned = !!pinned;
        doc.updatedAt = now();
        await persist(mem);
      }
      return mem;
    },

    async renameDoc(oldName, newName) {
      const mem = await ensureLoaded();
      const doc = findDoc(mem, oldName);
      if (doc && !findDoc(mem, newName)) {
        doc.name = String(newName);
        doc.updatedAt = now();
        await persist(mem);
      }
      return mem;
    },

    async deleteDoc(name) {
      const mem = await ensureLoaded();
      mem.docs = mem.docs.filter((d) => d.name.toLowerCase() !== String(name).toLowerCase());
      return persist(mem);
    },

    /** Acrescenta uma linha timestamped a um doc (cria se não existir). */
    async appendToDoc(name, text) {
      const clean = String(text ?? "").trim();
      if (!clean) return null;
      const mem = await ensureLoaded();
      let doc = findDoc(mem, name);
      if (!doc) {
        doc = { name: String(name), content: "# " + name + "\n", pinned: true, createdAt: now(), updatedAt: now() };
        mem.docs.push(doc);
      }
      // Dedup: ignora se já existe uma linha quase-igual (mesmo conjunto de
      // termos significativos) no documento — evita empilhar repetição.
      const wanted = normSig(clean);
      if (wanted) {
        const dup = doc.content.split("\n").some((l) => {
          const s = normSig(stripEntryPrefix(l));
          return s && (s === wanted || dice(s, wanted) >= 0.8);
        });
        if (dup) return { doc: doc.name, line: null, duplicate: true };
      }
      const line = `- (${today()}) ${clean}`;
      doc.content = doc.content.replace(/\s*$/, "") + "\n" + line + "\n";
      doc.updatedAt = now();
      await persist(mem);
      return { doc: doc.name, line };
    },

    /** Captura autônoma: usada pela detecção de "MEMÓRIA[arquivo]: ...". */
    async capture(text, filename) {
      const target = (filename && String(filename).trim()) || DEFAULT_TARGET;
      return this.appendToDoc(target, text);
    },

    /** Remove as linhas de um doc que contêm o trecho (case-insensitive).
     *  Retorna quantas linhas foram removidas. */
    async removeLines(name, needle) {
      const clean = String(needle ?? "").trim();
      if (!clean) return 0;
      const mem = await ensureLoaded();
      const doc = findDoc(mem, name);
      if (!doc) return 0;
      const n = clean.toLowerCase();
      const lines = doc.content.split("\n");
      const kept = lines.filter((l) => !l.toLowerCase().includes(n));
      const removed = lines.length - kept.length;
      if (removed) {
        doc.content = kept.join("\n");
        doc.updatedAt = now();
        await persist(mem);
      }
      return removed;
    },

    /** Substitui texto num doc (exato; fallback case-insensitive).
     *  Retorna quantas ocorrências foram substituídas. */
    async replaceText(name, oldText, newText) {
      const oldT = String(oldText ?? "");
      if (!oldT) return 0;
      const newT = String(newText ?? "");
      const mem = await ensureLoaded();
      const doc = findDoc(mem, name);
      if (!doc) return 0;
      let count = doc.content.split(oldT).length - 1;
      if (count) {
        doc.content = doc.content.split(oldT).join(newT);
      } else {
        const re = new RegExp(oldT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        const matches = doc.content.match(re);
        count = matches ? matches.length : 0;
        if (count) doc.content = doc.content.replace(re, newT);
      }
      if (count) {
        doc.updatedAt = now();
        await persist(mem);
      }
      return count;
    },

    async getSettings() {
      return (await ensureLoaded()).settings;
    },

    async setSetting(key, value) {
      const mem = await ensureLoaded();
      mem.settings[key] = value;
      return persist(mem);
    },

    /** Restaura tudo a partir das sementes (descarta a memória viva). */
    async resetToSeeds() {
      const mem = await buildFromSeeds();
      return persist(mem);
    },

    async replaceAll(mem) {
      const clean = normalize(mem);
      return persist(clean);
    },

    /** Recupera os trechos mais relevantes à consulta, entre os docs NÃO fixados
     *  (o pool de retrieval). Escala para memória grande sem despejar tudo. */
    async retrieve(query, opts = {}) {
      const mem = await ensureLoaded();
      const qTokens = tokenize(query);
      if (!qTokens.length) return [];
      const qSet = new Set(qTokens);
      const maxChunks = opts.maxChunks || 12;
      const maxChars = opts.maxChars || 3500;
      const pool = (opts.docs || mem.docs).filter((d) => !d.pinned && (d.content || "").trim());
      // Cap por doc: docs de LOG (ex.: diário do agente, com dezenas de linhas quase iguais) não
      // podem monopolizar as vagas e expulsar fatos curados de outros docs.
      const maxPerDoc = opts.maxPerDoc || 4;
      const scored = [];
      let idx = 0;
      for (const d of pool) {
        for (const c of chunkContent(d.content)) {
          const cTokens = tokenize(c.heading + " " + c.text);
          if (!cTokens.length) { idx++; continue; }
          const seen = new Set();
          let overlap = 0;
          for (const t of cTokens) if (qSet.has(t) && !seen.has(t)) { overlap++; seen.add(t); }
          if (!overlap) { idx++; continue; }
          const score = overlap / Math.sqrt(cTokens.length) + overlap * 0.15;
          scored.push({ doc: d.name, heading: c.heading, text: c.text, score, idx });
          idx++;
        }
      }
      // Empate de score → vence o chunk MAIS RECENTE (maior idx: em docs de append, o mais novo
      // fica no fim — antes o sort estável mantinha os mais ANTIGOS e cortava justamente o de ontem).
      scored.sort((a, b) => b.score - a.score || b.idx - a.idx);
      const out = [];
      const perDoc = {};
      let chars = 0;
      for (const s of scored) {
        if (out.length >= maxChunks) break;
        if ((perDoc[s.doc] || 0) >= maxPerDoc) continue;
        chars += s.text.length;
        if (chars > maxChars && out.length) break;
        perDoc[s.doc] = (perDoc[s.doc] || 0) + 1;
        out.push(s);
      }
      return out;
    },

    /** RAG sobre as MENSAGENS de UMA conversa retomada. Recebe chunks já montados
     *  ({role, ts, text, hidden}) e devolve os top-K relevantes à query, preservando os
     *  metadados. Reusa as MESMAS primitivas (tokenize + fórmula de score + desempate por
     *  recência) de retrieve(), sem depender de docs/pinned. */
    retrieveConversation(query, chunks, opts = {}) {
      const qTokens = tokenize(query);
      if (!qTokens.length || !Array.isArray(chunks)) return [];
      const qSet = new Set(qTokens);
      const maxChunks = opts.maxChunks || 8;
      const maxChars = opts.maxChars || 4000;
      const scored = [];
      let idx = 0;
      for (const c of chunks) {
        idx++;
        const cTokens = tokenize(c.text || "");
        if (!cTokens.length) continue;
        const seen = new Set();
        let overlap = 0;
        for (const tk of cTokens) if (qSet.has(tk) && !seen.has(tk)) { overlap++; seen.add(tk); }
        if (!overlap) continue;
        const score = overlap / Math.sqrt(cTokens.length) + overlap * 0.15;
        scored.push({ role: c.role, ts: c.ts, hidden: !!c.hidden, text: c.text, score, idx });
      }
      scored.sort((a, b) => b.score - a.score || b.idx - a.idx);
      const out = [];
      let chars = 0;
      for (const s of scored) {
        if (out.length >= maxChunks) break;
        chars += (s.text || "").length;
        if (chars > maxChars && out.length) break;
        out.push(s);
      }
      return out;
    },

    /** Monta o bloco injetado: núcleo fixo (sempre) + trechos recuperados por
     *  relevância à mensagem atual (query). Sem query, injeta só o núcleo. */
    async compose(query) {
      const mem = await ensureLoaded();
      const pinned = mem.docs.filter((d) => d.pinned && (d.content || "").trim());
      const retrieved = query ? await this.retrieve(query) : [];
      if (!pinned.length && !retrieved.length) return "";
      const allNames = mem.docs.map((d) => d.name).join(", ");
      const header =
        "=== MEMÓRIA PERSISTENTE DO CLAUDE (contexto durável sobre mim) ===\n" +
        "Você tem memória persistente entre conversas, em documentos markdown.\n" +
        "Arquivos: " + allNames + "\n" +
        "Data e hora AGORA (fuso local do usuário): " + new Date().toLocaleString() + ". Use isto p/ saber quanto tempo passou desde a última mensagem (as mensagens retomadas trazem [horário] inline) — útil quando a tarefa depende de uma janela de soak/espera.\n" +
        "Abaixo vai o núcleo fixo + trechos recuperados por relevância à minha mensagem.\n" +
        "Você mesmo MANTÉM essa memória: para criar, editar ou apagar registros, escreva\n" +
        "um comando em LINHA ISOLADA em qualquer ponto da resposta (a extensão executa e\n" +
        "salva sozinha; não peça permissão para o óbvio, só confirme em uma frase). Prefira\n" +
        "ATUALIZAR/SUBSTITUIR um fato existente a empilhar um novo quase-igual:\n" +
        "    MEMÓRIA: <fato conciso>                             -> adiciona em memoria-viva.md\n" +
        "    MEMÓRIA[arquivo.md]: <fato conciso>                 -> adiciona no arquivo indicado\n" +
        "    MEMÓRIA-APAGAR[arquivo.md]: <trecho>                -> apaga as LINHAS que contêm o trecho\n" +
        "    MEMÓRIA-SUBSTITUIR[arquivo.md]: <antigo> >>> <novo> -> substitui o texto no arquivo\n" +
        "REGISTRE SEM SER PEDIDO (auto-journaling): sempre que a conversa produzir uma DECISÃO,\n" +
        "uma ALTERAÇÃO feita em site/sistema, uma estratégia com hipótese a medir depois, ou um\n" +
        "fato durável novo, inclua a(s) linha(s) MEMÓRIA: correspondentes na resposta — o quê\n" +
        "mudou, por quê, e quando medir. Nunca registre senhas ou dados sensíveis.\n";
      let body = pinned
        .map((d) => `\n----- ${d.name} -----\n${d.content.trim()}`)
        .join("\n");
      if (retrieved.length) {
        const rel = retrieved
          .map((r) => `- ${r.text.replace(/^[-*]\s*/, "")}  [${r.doc}${r.heading ? " › " + r.heading : ""}]`)
          .join("\n");
        body += "\n\n----- trechos relevantes ao que perguntei -----\n" + rel;
      }
      return header + body + "\n\n=== FIM DA MEMÓRIA ===\n";
    },

    // --- Dedup de marcadores já capturados ---
    async isMarkerSaved(hash) {
      const out = await chrome.storage.local.get(MARKERS_KEY);
      const set = (out && out[MARKERS_KEY]) || [];
      return set.includes(hash);
    },
    async markMarkerSaved(hash) {
      const out = await chrome.storage.local.get(MARKERS_KEY);
      const set = (out && out[MARKERS_KEY]) || [];
      if (!set.includes(hash)) {
        set.push(hash);
        while (set.length > 500) set.shift();
        await chrome.storage.local.set({ [MARKERS_KEY]: set });
      }
    },
  };

  globalThis.ClaudeMemory = ClaudeMemory;
})();
