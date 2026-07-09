/* Editor completo da memória do Claude (modelo multi-documento). */
(function () {
  "use strict";
  const M = globalThis.ClaudeMemory;
  const $ = (id) => document.getElementById(id);

  let docs = [];
  let current = null;
  let dirty = false;

  function flash(msg, ok = true) {
    const s = $("status");
    s.textContent = msg;
    s.style.color = ok ? "#8fce8f" : "#ff9b9b";
    setTimeout(() => (s.textContent = ""), 2500);
  }

  async function reload(select) {
    const mem = await M.load();
    docs = mem.docs;
    $("updated").textContent = mem.updatedAt ? "Atualizada: " + new Date(mem.updatedAt).toLocaleString() : "";
    renderList();
    const pick = select || current || (docs[0] && docs[0].name);
    if (pick) select_(pick);
  }

  function renderList() {
    const list = $("list");
    list.innerHTML = "";
    for (const d of docs) {
      const row = document.createElement("div");
      row.className = "doc" + (d.pinned ? " pinned" : "") + (d.name === current ? " active" : "");
      const pin = document.createElement("span");
      pin.className = "pin";
      pin.innerHTML = globalThis.LucideIcons ? globalThis.LucideIcons.get("pin", 14) : "";
      const name = document.createElement("span");
      name.textContent = d.name;
      name.style.flex = "1";
      name.style.overflow = "hidden";
      name.style.textOverflow = "ellipsis";
      row.appendChild(name);
      row.appendChild(pin);
      row.addEventListener("click", () => {
        if (dirty && !confirm("Descartar alterações não salvas?")) return;
        select_(d.name);
      });
      list.appendChild(row);
    }
  }

  function select_(name) {
    current = name;
    const d = docs.find((x) => x.name === name);
    $("doc-name").textContent = name;
    $("content").value = d ? d.content : "";
    $("pin").checked = d ? !!d.pinned : false;
    dirty = false;
    renderList();
  }

  $("content").addEventListener("input", () => (dirty = true));

  $("save").addEventListener("click", async () => {
    if (!current) return;
    await M.upsertDoc(current, $("content").value, $("pin").checked);
    dirty = false;
    flash("Salvo.");
    reload(current);
  });

  $("pin").addEventListener("change", async () => {
    if (!current) return;
    await M.setPinned(current, $("pin").checked);
    reload(current);
  });

  $("new").addEventListener("click", async () => {
    let name = prompt("Nome do novo documento (ex.: projetos.md):", "novo.md");
    if (!name) return;
    name = name.trim();
    if (!/\.md$/i.test(name)) name += ".md";
    await M.upsertDoc(name, "# " + name.replace(/\.md$/i, "") + "\n\n", true);
    reload(name);
  });

  $("rename").addEventListener("click", async () => {
    if (!current) return;
    let name = prompt("Novo nome:", current);
    if (!name) return;
    name = name.trim();
    if (!/\.md$/i.test(name)) name += ".md";
    await M.renameDoc(current, name);
    current = name;
    reload(name);
  });

  $("delete").addEventListener("click", async () => {
    if (!current) return;
    if (!confirm("Apagar o documento " + current + "?")) return;
    await M.deleteDoc(current);
    current = null;
    reload();
  });

  $("export").addEventListener("click", async () => {
    const mem = await M.load();
    const blob = new Blob([JSON.stringify(mem, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "claude-memoria-backup.json";
    a.click();
    URL.revokeObjectURL(url);
    flash("Backup exportado.");
  });

  $("import").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.docs)) throw new Error("sem docs");
      await M.replaceAll(data);
      current = null;
      flash("Backup importado.");
      reload();
    } catch (err) {
      flash("Arquivo inválido.", false);
    }
    e.target.value = "";
  });

  $("reset").addEventListener("click", async () => {
    if (!confirm("Restaurar as sementes originais? Isso descarta a memória viva atual.")) return;
    await M.resetToSeeds();
    current = null;
    flash("Sementes restauradas.");
    reload();
  });

  function applyIcons() {
    if (!globalThis.LucideIcons) return;
    document.querySelectorAll("[data-icon]").forEach((el) => {
      const size = el.tagName === "H1" ? 20 : 15;
      el.insertAdjacentHTML("afterbegin", globalThis.LucideIcons.get(el.dataset.icon, size) + " ");
    });
  }

  applyIcons();
  reload();
})();
