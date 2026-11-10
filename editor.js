function createOutputItem(entry, targetDocument = document) {
  const item = targetDocument.createElement("li");
  if (entry.type === "dummy") {
    const text = targetDocument.createElement("div");
    text.className = "dummy-post";
    text.textContent = entry.text;
    item.appendChild(text);
  } else if (entry.type === "post") {
    item.appendChild(renderSnapshot(entry));
  } else {
    throw new Error("出力ログの投稿形式が不正です。");
  }
  return item;
}

function unaddedEntries(entries, items) {
  const addedIds = new Set(items.filter((entry) => entry.type === "post").map((entry) => entry.messageId));
  return entries.filter((entry) => !addedIds.has(entry.messageId));
}

function createEditorItem(entry, index, count, onAction) {
  const item = createOutputItem(entry);
  const actions = document.createElement("div");
  actions.className = "item-actions";
  for (const [label, direction, boundary] of [
    ["▲上に1つ移動", -1, index === 0],
    ["▼下に1つ移動", 1, index === count - 1],
    ["この項目を削除", 0, false],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.boundary = String(boundary);
    button.addEventListener("click", () => onAction(entry.id, direction));
    actions.appendChild(button);
  }
  item.appendChild(actions);
  return item;
}

function createExportHtml(name, entries) {
  const output = document.implementation.createHTMLDocument(name);
  const charset = output.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  output.head.prepend(charset);
  const policy = output.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  output.head.appendChild(policy);
  const style = output.createElement("style");
  style.textContent = `body { font-family: sans-serif; background: #555; color: white; margin: 24px; } ${logDisplayStyles}`;
  output.head.appendChild(style);
  const heading = output.createElement("h1");
  heading.textContent = name;
  const list = output.createElement("ol");
  list.className = "log-list";
  for (const entry of entries) {
    list.appendChild(createOutputItem(entry, output));
  }
  output.body.append(heading, list);
  return `<!doctype html>\n${output.documentElement.outerHTML}`;
}

function insertEditor(sidebar) {
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; font-family: sans-serif; }
    * { box-sizing: border-box; }
    dialog {
      position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none;
      margin: 0; padding: 0; border: 0; background: #555; color: white; font: 14px sans-serif;
    }
    dialog::backdrop { background: rgba(0, 0, 0, .7); }
    .layout { display: flex; flex-direction: column; height: 100%; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; background: #333; }
    h1 { font-size: 20px; margin: 0; }
    h2 { font-size: 17px; margin: 0 0 10px; }
    .columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); min-height: 0; flex: 1; }
    .column { min-width: 0; overflow-y: auto; padding: 16px; }
    .column + .column { border-left: 1px solid #aaa; }
    .controls { display: grid; gap: 8px; }
    .row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
    button, input, select, textarea { font: inherit; }
    button { padding: 7px 10px; cursor: pointer; }
    button:disabled { cursor: default; }
    input, textarea, select { min-width: 0; padding: 6px; }
    textarea { flex: 1; min-height: 36px; resize: vertical; }
    input { flex: 1; }
    .status { min-height: 1.4em; margin: 8px 0 0; }
    ${logDisplayStyles}
    .log-list .move, .log-list .item-actions button { padding: 6px; border: 1px solid white; }
    .log-list .move, .log-list .item-actions { margin-top: 8px; }
    .log-list .item-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .log-list button:disabled { opacity: .5; }
    @media (max-width: 650px) {
      .columns { grid-template-columns: 1fr; overflow-y: auto; }
      .column { overflow-y: visible; }
      .column + .column { border-left: 0; border-top: 1px solid #aaa; }
    }
  `;
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", "ログ整理とHTML出力");
  dialog.innerHTML = `
    <div class="layout">
      <header><h1>LeciAcaLogGetter - ログ整理&amp;HTML出力</h1>
        <button type="button" class="close">閉じる（ログ収集に戻る）</button></header>
      <div class="columns">
        <section class="column">
          <h2>収集ログリスト</h2>
          <button type="button" class="move-all">IDが小さいものから全て出力に追加</button>
          <ol class="log-list collected" aria-label="収集ログ"></ol>
        </section>
        <section class="column">
          <h2>編集対象ログリスト</h2>
          <div class="controls">
            <div class="row"><label for="output-select">出力対象ログリスト</label>
              <select id="output-select" class="select"></select>
              <button type="button" class="create">新規ログ作成</button>
              <button type="button" class="delete">このログを削除</button></div>
            <div class="row"><textarea class="dummy-text" aria-label="ダミー投稿の内容" placeholder="ダミー投稿の内容"></textarea>
              <button type="button" class="dummy-add">ダミー投稿追加</button></div>
            <div class="row"><input class="name" aria-label="ログ名称" placeholder="ログ名称">
              <button type="button" class="rename">ログ名称変更</button>
              <button type="button" class="download">HTMLとしてダウンロード</button></div>
          </div>
          <p class="status" role="status" aria-live="polite"></p>
          <ol class="log-list output" aria-label="編集中ログ"></ol>
        </section>
      </div>
    </div>`;
  shadow.append(style, dialog);
  document.body.appendChild(host);
  const get = (selector) => dialog.querySelector(selector);
  const select = get(".select");
  const collected = get(".collected");
  const outputList = get(".output");
  const status = get(".status");
  const nameInput = get(".name");
  const dummyInput = get(".dummy-text");
  let selectedId = null;
  let version = 0;
  let busy = false;
  let refreshing = false;
  let ready = false;

  function report(error) {
    console.error("ログ整理に失敗しました:", error);
    status.textContent = `ログ整理に失敗しました: ${error.message}`;
    if (!ready) status.textContent += " 閉じてもう一度開いてください。";
  }

  function setDisabled() {
    const noSelection = selectedId === null;
    const unavailable = busy || refreshing || !ready;
    for (const element of dialog.querySelectorAll(".delete, .dummy-text, .dummy-add, .name, .rename, .download, .move-all, .move, .item-actions button")) {
      element.disabled = unavailable || noSelection || element.dataset.boundary === "true";
    }
    select.disabled = unavailable || noSelection;
    get(".create").disabled = unavailable;
  }

  async function refresh() {
    const current = ++version;
    refreshing = true;
    ready = false;
    setDisabled();
    try {
      await renderEditor(current);
    } finally {
      if (current === version) {
        refreshing = false;
        setDisabled();
      }
    }
  }

  async function renderEditor(current) {
    const [outputs, entries] = await Promise.all([logRequest("output-list"), logRequest("log-list-all")]);
    if (current !== version || !dialog.open) return;
    if (!outputs.some((output) => output.id === selectedId)) selectedId = outputs[0]?.id ?? null;
    const selected = outputs.find((output) => output.id === selectedId);
    const items = selected ? await logRequest("output-items", { outputId: selectedId }) : [];
    if (current !== version || !dialog.open) return;

    const options = outputs.map((output) => {
      const option = document.createElement("option");
      option.value = String(output.id);
      option.textContent = `${output.name}（${output.count}件）`;
      return option;
    });
    if (!options.length) {
      const option = document.createElement("option");
      option.textContent = "出力ログを作成してください";
      option.value = "";
      options.push(option);
    }
    select.replaceChildren(...options);
    select.value = selectedId === null ? "" : String(selectedId);
    if (document.activeElement !== nameInput && shadow.activeElement !== nameInput) {
      nameInput.value = selected?.name ?? "";
    }
    const collectedItems = unaddedEntries(entries, items).map((entry) => {
      const item = document.createElement("li");
      item.appendChild(renderSnapshot(entry));
      const move = document.createElement("button");
      move.type = "button";
      move.className = "move";
      move.textContent = "保存項目に移行";
      move.addEventListener("click", () => {
        const outputId = selectedId;
        run(async () => {
          const result = await logRequest("output-move", { outputId, messageId: entry.messageId });
          status.textContent = result.skipped ? "同じ投稿は既に出力ログにあります。" : "投稿を出力ログに追加しました。";
        });
      });
      item.appendChild(move);
      return item;
    });
    collected.replaceChildren(...collectedItems);
    const outputItems = items.map((entry, index) => createEditorItem(entry, index, items.length, (itemId, direction) => {
      const outputId = selectedId;
      run(async () => {
        if (direction === 0) {
          await logRequest("output-item-remove", { outputId, itemId });
          status.textContent = "項目を出力ログから削除しました。";
        } else {
          const moved = await logRequest("output-item-reorder", { outputId, itemId, direction });
          status.textContent = moved ? "項目の順序を変更しました。" : "これ以上移動できません。";
        }
      });
    }));
    outputList.replaceChildren(...outputItems);
    ready = true;
  }

  function run(action) {
    if (busy || refreshing || !ready) return;
    busy = true;
    setDisabled();
    return enqueueLogTask(async () => {
      try {
        await action();
        await Promise.all([refresh(), refreshLogs(sidebar)]);
      } catch (error) {
        report(error);
      } finally {
        busy = false;
        setDisabled();
      }
    });
  }

  sidebar["export-mode"].addEventListener("click", () => {
    status.textContent = "";
    dialog.showModal();
    refresh().catch(report);
  });
  get(".close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { version++; });
  select.addEventListener("change", () => {
    selectedId = Number(select.value);
    nameInput.value = "";
    refresh().catch(report);
  });
  get(".create").addEventListener("click", () => {
    const name = prompt("新しいログの名称を入力してください。");
    if (name === null) return;
    run(async () => {
      selectedId = await logRequest("output-create", { name });
      nameInput.value = name.trim();
      status.textContent = "出力ログを作成しました。";
    });
  });
  get(".delete").addEventListener("click", () => {
    const label = select.selectedOptions[0]?.textContent || "";
    if (!confirm(`「${label}」を削除しますか？出力ログ内の投稿も削除されますが、収集ログには影響しません。`)) return;
    const outputId = selectedId;
    run(async () => {
      await logRequest("output-delete", { outputId });
      selectedId = null;
      nameInput.value = "";
      status.textContent = "出力ログとその投稿を削除しました。";
    });
  });
  get(".dummy-add").addEventListener("click", () => {
    const outputId = selectedId;
    return run(async () => {
      await logRequest("output-dummy", { outputId, text: dummyInput.value });
      dummyInput.value = "";
      status.textContent = "ダミー投稿を先頭に追加しました。";
    });
  });
  get(".rename").addEventListener("click", () => {
    const outputId = selectedId;
    return run(async () => {
      await logRequest("output-rename", { outputId, name: nameInput.value });
      nameInput.value = nameInput.value.trim();
      status.textContent = "ログ名称を変更しました。";
    });
  });
  get(".move-all").addEventListener("click", () => {
    const outputId = selectedId;
    return run(async () => {
      const result = await logRequest("output-move-all", { outputId });
      status.textContent = `${result.moved}件を出力ログに追加しました。${result.skipped ? `追加済みの${result.skipped}件は除きました。` : ""}`;
    });
  });
  get(".download").addEventListener("click", () => {
    const outputId = selectedId;
    return run(async () => {
      const outputs = await logRequest("output-list");
      const selected = outputs.find((output) => output.id === outputId);
      if (!selected) throw new Error("出力ログが見つかりません。");
      const items = await logRequest("output-items", { outputId });
      const blob = new Blob([createExportHtml(selected.name, items)], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${selected.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 100)}.html`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      status.textContent = "HTMLをダウンロードしました。";
    });
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "logs-changed" && dialog.open) refresh().catch(report);
  });
}

insertEditor(ui);
