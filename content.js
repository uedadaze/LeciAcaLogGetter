let logQueue = Promise.resolve();
let lastCaptureRequestedAt = 0;
const captureSelector = ".room-message-header .room-message-icon .icon-wrapper, .room-message-content img";

function getCaptureTargets(message) {
  return Array.from(message.querySelectorAll(captureSelector), (element) => ({
    element,
    html: element.outerHTML,
  }));
}

function nextPaint() {
  return new Promise((resolve, reject) => {
    let frame;
    const cleanup = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        cleanup();
        reject(new Error("撮影中にタブが非表示になりました。"));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("画面の描画を確認できませんでした。"));
    }, 2000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (document.visibilityState !== "visible") {
      onVisibilityChange();
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        cleanup();
        resolve();
      });
    });
  });
}

async function decodeCaptureImage(image) {
  try {
    await image.decode();
    return true;
  } catch (error) {
    if (error?.name !== "EncodingError") {
      throw error;
    }
    console.warn("画像をデコードできなかったため、空欄にします:", error);
    return false;
  }
}

async function captureElement(element, dialog) {
  if (!element.isConnected) {
    throw new Error("撮影する画像がページから削除されました。");
  }
  if (!element.getClientRects().length) {
    return null;
  }
  if (element instanceof HTMLImageElement) {
    if (!await decodeCaptureImage(element)) {
      return undefined;
    }
  } else {
    for (const image of element.querySelectorAll("img")) {
      if (!await decodeCaptureImage(image)) {
        return undefined;
      }
    }
  }
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  await nextPaint();
  const rect = element.getBoundingClientRect();
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  if (document.visibilityState !== "visible") {
    throw new Error("撮影中にタブが非表示になりました。");
  }
  const visibleLeft = Math.max(0, rect.left);
  const visibleTop = Math.max(0, rect.top);
  const visibleRight = Math.min(width, rect.right);
  const visibleBottom = Math.min(height, rect.bottom);
  if (rect.width <= 0 || rect.height <= 0 ||
      visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
    return null;
  }

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const wait = Math.max(0, 550 - (Date.now() - lastCaptureRequestedAt));
  if (wait) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  dialog.setAttribute("data-capturing", "");
  let result;
  try {
    await nextPaint();
    lastCaptureRequestedAt = Date.now();
    result = await chrome.runtime.sendMessage({ type: "capture-log-image" });
  } finally {
    dialog.removeAttribute("data-capturing");
  }
  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.image) {
    throw new Error("画面キャプチャの結果がありません。");
  }
  const after = element.getBoundingClientRect();
  if (!element.isConnected || document.visibilityState !== "visible" ||
      window.innerWidth !== viewportWidth || window.innerHeight !== viewportHeight ||
      ["left", "top", "width", "height"].some((key) => Math.abs(rect[key] - after[key]) > 0.5)) {
    throw new Error("撮影中に画像の位置が変わりました。");
  }
  const screenshot = new Image();
  screenshot.src = result.image;
  if (!await decodeCaptureImage(screenshot)) {
    return undefined;
  }
  const scaleX = screenshot.naturalWidth / viewportWidth;
  const scaleY = screenshot.naturalHeight / viewportHeight;
  const left = Math.floor(visibleLeft * scaleX);
  const top = Math.floor(visibleTop * scaleY);
  const right = Math.min(screenshot.naturalWidth, Math.ceil(visibleRight * scaleX));
  const bottom = Math.min(screenshot.naturalHeight, Math.ceil(visibleBottom * scaleY));
  const canvas = document.createElement("canvas");
  canvas.width = right - left;
  canvas.height = bottom - top;
  const context = canvas.getContext("2d");
  if (!context || canvas.width <= 0 || canvas.height <= 0) {
    throw new Error("画像の切り出しに失敗しました。");
  }
  context.drawImage(screenshot, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

async function captureImages(message, snapshot, sidebar, targets, dialog) {
  const copies = snapshot.querySelectorAll(captureSelector);
  const verifyTargets = () => {
    const current = message.querySelectorAll(captureSelector);
    if (current.length !== targets.length || targets.some((target, index) =>
      current[index] !== target.element || target.element.outerHTML !== target.html
    )) {
      throw new Error("投稿の画像が変更されたため、ログを追加できません。");
    }
  };
  if (targets.length !== copies.length) {
    throw new Error("投稿の画像が変更されたため、ログを追加できません。");
  }
  verifyTargets();
  if (!targets.length) {
    return;
  }

  const positions = new Map();
  for (const target of targets) {
    for (let node = target.element; node; node = node.parentElement) {
      if (!positions.has(node)) {
        positions.set(node, { left: node.scrollLeft, top: node.scrollTop });
      }
    }
  }
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const visibility = sidebar.style.visibility;
  sidebar.style.visibility = "hidden";
  try {
    for (let index = 0; index < targets.length; index++) {
      verifyTargets();
      const source = targets[index].element;
      const copy = copies[index];
      const data = await captureElement(source, dialog);
      verifyTargets();
      if (data == null) {
        const placeholder = document.createElement("span");
        if (data === null) {
          placeholder.textContent = "【画像を撮影できませんでした】";
        }
        if (source.matches("img")) {
          copy.replaceWith(placeholder);
        } else {
          copy.replaceChildren(placeholder);
        }
      } else if (source.matches("img")) {
        copy.removeAttribute("srcset");
        copy.removeAttribute("sizes");
        const picture = copy.closest("picture");
        if (picture) {
          for (const pictureSource of picture.querySelectorAll("source")) {
            pictureSource.remove();
          }
        }
        copy.src = data;
      } else {
        const image = document.createElement("img");
        image.src = data;
        image.alt = source.querySelector("img")?.alt || "アイコン";
        copy.replaceChildren(image);
      }
    }
  } finally {
    sidebar.style.visibility = visibility;
    for (const [node, position] of positions) {
      node.scrollLeft = position.left;
      node.scrollTop = position.top;
    }
    window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
  }
}

async function logRequest(type, fields = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...fields });
  if (!response || response.error) {
    throw new Error(response?.error || "ログ操作の応答がありません。");
  }
  return response.value;
}

function messageId(message) {
  const match = /^message-(\d+)$/.exec(message.id);
  if (!match) {
    throw new Error("投稿IDを取得できませんでした。");
  }
  return BigInt(match[1]).toString();
}

function enqueueLogTask(task) {
  const job = logQueue.then(task);
  logQueue = job.catch((error) => {
    console.error("ログ操作に失敗しました:", error);
    alert(`ログ操作に失敗しました: ${error.message}`);
  });
  return logQueue;
}

function sanitizeSnapshot(snapshot) {
  for (const element of snapshot.querySelectorAll(
    "button.leci-aca-log-getter-add, div.room-message-meta-aside, script, iframe, object, embed, link, style, base, meta"
  )) {
    element.remove();
  }
  for (const element of [snapshot, ...snapshot.querySelectorAll("*")]) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name) || attribute.name.toLowerCase() === "srcdoc" ||
          (["href", "src", "action", "formaction", "xlink:href"].includes(attribute.name.toLowerCase()) &&
           /^\s*javascript:/i.test(attribute.value))) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

function formatSnapshot(snapshot) {
  for (const image of snapshot.querySelectorAll("img")) {
    if (image.nextSibling?.nodeName !== "BR") {
      image.after(document.createElement("br"));
    }
  }
  for (const span of snapshot.querySelectorAll('span[class*="dice"]')) {
    span.className = "dice";
  }
}

function renderSnapshot(entry) {
  const template = document.createElement("template");
  template.innerHTML = entry.html;
  const snapshot = template.content.firstElementChild;
  if (!snapshot || template.content.children.length !== 1 || !snapshot.matches("section.room-message")) {
    throw new Error(`投稿ID ${entry.messageId} の保存内容が不正です。`);
  }
  sanitizeSnapshot(snapshot);
  formatSnapshot(snapshot);
  snapshot.inert = true;
  return snapshot;
}

async function addMessage(message, sidebar, dialog) {
  const id = messageId(message);
  if (await logRequest("log-contains", { messageId: id })) {
    return false;
  }
  if (!message.isConnected) {
    throw new Error("投稿がページから削除されました。");
  }
  const snapshot = message.cloneNode(true);
  const targets = getCaptureTargets(message);
  await captureImages(message, snapshot, sidebar, targets, dialog);
  sanitizeSnapshot(snapshot);
  formatSnapshot(snapshot);
  return logRequest("log-add", { messageId: id, html: snapshot.outerHTML });
}

let refreshVersion = 0;
async function refreshLogs(ui) {
  const version = ++refreshVersion;
  const result = await logRequest("log-list");
  if (version !== refreshVersion) {
    return;
  }
  const items = [];
  for (const entry of [...result.entries].reverse()) {
    const snapshot = renderSnapshot(entry);
    const item = document.createElement("li");
    item.tabIndex = 0;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "log-delete";
    remove.textContent = "✗";
    remove.setAttribute("aria-label", `投稿 ${entry.messageId} を削除`);
    remove.addEventListener("click", () => enqueueLogTask(async () => {
      await logRequest("log-remove", { messageId: entry.messageId });
      await refreshLogs(ui);
    }));
    item.appendChild(remove);
    item.appendChild(snapshot);
    items.push(item);
  }
  ui.logList.replaceChildren(...items);
  ui.count.textContent = `保持しているログ: ${result.count}件`;
}

function insertLogButtons(ui) {
  const actionContainers = document.querySelectorAll(
    "section.room-message div.room-message-actions"
  );
  for (const container of actionContainers) {
    if (container.querySelector(":scope > button.leci-aca-log-getter-add")) {
      continue;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "leci-aca-log-getter-add";
    button.textContent = "ログ追加";
    button.style.backgroundColor = "green";
    button.style.color = "white";
    button.addEventListener("click", () => {
      const message = container.closest("section.room-message");
      if (!message) {
        console.error("ログ追加: 対応する投稿が見つかりません。");
        return;
      }
      if (ui.progress.dialog.open) {
        return;
      }
      ui.progress.show(false);
      button.disabled = true;
      return enqueueLogTask(async () => {
        try {
          const added = await addMessage(message, ui.host, ui.progress.dialog);
          ui.status.textContent = added ? "ログを追加しました。" : "この投稿は追加済みです。";
          await refreshLogs(ui);
        } finally {
          button.disabled = false;
          ui.progress.close();
        }
      });
    });
    container.appendChild(button);
  }
}

function insertProgressDialog() {
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    dialog {
      padding: 24px 32px;
      border: 1px solid #aaa;
      border-radius: 8px;
      background: #333;
      color: white;
      font: 16px sans-serif;
      text-align: center;
    }
    dialog::backdrop { background: rgba(0, 0, 0, 0.65); }
    dialog[data-capturing] { visibility: hidden; }
    dialog[data-capturing]::backdrop { background: transparent; }
    h2 { margin: 0; font-size: 20px; }
    p { margin: 12px 0 0; }
    p:empty { display: none; }
  `;
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "log-progress-title");
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  const title = document.createElement("h2");
  title.id = "log-progress-title";
  title.textContent = "投稿追加中";
  const details = document.createElement("p");
  details.setAttribute("aria-live", "polite");
  dialog.appendChild(title);
  dialog.appendChild(details);
  shadow.appendChild(style);
  shadow.appendChild(dialog);
  document.body.appendChild(host);
  return {
    dialog,
    show(bulk) {
      details.textContent = bulk ? "追加件数を確認中..." : "";
      dialog.showModal();
    },
    update(total, remaining) {
      details.textContent = `追加予定: ${total}件 / 残り: ${remaining}件`;
    },
    close() {
      dialog.close();
    },
  };
}

const logDisplayStyles = `
    .log-list { margin: 16px 0 0; padding: 0; list-style: none; }
    .log-list > li {
      position: relative;
      margin-bottom: 8px;
      padding: 10px;
      border: 1px solid white;
      overflow-x: auto;
      overflow-wrap: anywhere;
    }
    .log-list > li, .log-list > li * {
      background-color: black !important;
      color: white !important;
    }
    .log-list .log-delete {
      position: sticky;
      float: right;
      right: 0;
      top: 0;
      z-index: 1;
      padding: 2px 6px;
      border: 1px solid white;
    }
    .log-list .room-message-header {
      display: flex;
      align-items: center;
      gap: 8px;
      width: max-content;
      min-width: 100%;
      white-space: nowrap;
    }
    .log-list .room-message-icon { flex: 0 0 60px; }
    .log-list .room-message-meta {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .log-list .room-message-meta-row-sub {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .log-list .room-message-info { font-weight: bold; }
    .log-list .room-message-meta-sub,
    .log-list .room-message-meta-time { font-size: 0.8em; }
    .log-list .room-message-meta-sub,
    .log-list .room-message-meta-sub *,
    .log-list .room-message-meta-time,
    .log-list .room-message-meta-time * { color: #aaa !important; }
    .log-list span.bold { font-weight: bold !important; }
    .log-list span.dice, .log-list span.dice * {
      color: orange !important;
      font-weight: bold !important;
    }
    .log-list span.strike { text-decoration-line: line-through !important; }
    .log-list span.italic { font-style: italic !important; }
    .log-list span.underline { text-decoration-line: underline !important; }
    .log-list span.strike.underline { text-decoration-line: underline line-through !important; }
    .log-list span.small-1 { font-size: 70% !important; }
    .log-list span.small-2 { font-size: 75% !important; }
    .log-list span.small-3 { font-size: 80% !important; }
    .log-list span.small-4 { font-size: 85% !important; }
    .log-list span.small-5 { font-size: 90% !important; }
    .log-list span.large-1 { font-size: 120% !important; }
    .log-list span.large-2 { font-size: 140% !important; }
    .log-list span.large-3 { font-size: 160% !important; }
    .log-list span.large-4 { font-size: 180% !important; }
    .log-list span.large-5 { font-size: 200% !important; }
    .log-list .log-card {
      display: block;
      box-sizing: border-box;
      margin: 6px 0;
      padding: 8px;
      border: 1px solid white;
      background-color: #333 !important;
    }
    .log-list .log-card * { background-color: transparent !important; }
    .log-list .log-card-header { display: flex; flex-wrap: wrap; align-items: baseline; }
    .log-list .log-card-result, .log-list .log-card-title { font-weight: bold !important; }
    .log-list .log-card-title { margin-left: 0.5em; }
    .log-list .log-card-title:not(.log-card-header .log-card-title)::after {
      content: "";
      display: block;
    }
    .log-list .log-card-footer {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5em;
      font-size: 80%;
    }
    .log-list .log-card-footer span { font-size: 1em !important; }
    .log-list .log-card-title ~ span { font-size: 80% !important; }
    .log-list .log-card-title ~ span + span { margin-left: 0.5em; }
    .log-list img { max-width: 100%; height: auto; }
    .log-list .icon-wrapper > img {
      width: 60px !important;
      height: 60px !important;
      min-width: 60px;
      max-width: 60px;
      min-height: 60px;
      max-height: 60px;
    }
    .log-list .dummy-post { white-space: pre-wrap; }
`;

function insertSidebar() {
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
      position: fixed;
      top: 0;
      right: 0;
      z-index: 2147483647;
      display: flex;
      align-items: flex-start;
      font-family: sans-serif;
      transform: translateX(calc(100% - 40px));
      transition: transform 300ms ease;
    }
    :host([data-open]) { transform: translateX(0); }
    * { box-sizing: border-box; }
    button {
      font: inherit;
      color: #222;
      background: #f5f5f5;
      border: 1px solid #888;
      border-radius: 4px;
      cursor: pointer;
    }
    .toggle { width: 40px; padding: 8px 0; background: white; }
    .panel {
      width: 600px;
      height: 100vh;
      padding: 20px;
      overflow-y: auto;
      background: #555;
      color: #222;
      border-left: 1px solid #aaa;
      box-shadow: -2px 0 8px rgba(0, 0, 0, 0.15);
    }
    h2 { margin: 0 0 16px; font-size: 20px; text-align: center; color: #ffd700; }
    .actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .actions button { padding: 10px; color: white; overflow-wrap: anywhere; }
    .log-summary { grid-column: 1 / -1; color: white; }
    .log-summary p { margin: 4px 0; }
    .add-all { background: #087a30; }
    .delete-all { background: #b3261e; }
    .export-mode { background: #6f2da8; grid-column: 1 / -1; }
    ${logDisplayStyles}
    @media (prefers-reduced-motion: reduce) {
      :host { transition: none; }
    }
  `;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "toggle";
  toggle.textContent = "<";
  toggle.setAttribute("aria-label", "フレームを開く");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "leci-aca-log-getter-panel");

  const panel = document.createElement("aside");
  panel.id = "leci-aca-log-getter-panel";
  panel.className = "panel";
  panel.inert = true;
  panel.setAttribute("aria-label", "LeciAcaLogGetter");
  panel.setAttribute("aria-hidden", "true");

  const title = document.createElement("h2");
  title.textContent = "LeciAcaLogGetter v1.0";
  const actions = document.createElement("div");
  actions.className = "actions";
  const actionButtons = {};
  for (const [label, className] of [
    ["ページ内の全投稿をID順に追加", "add-all"],
    ["取得したログを全て削除", "delete-all"],
    ["ログ整理＆HTML出力モードへ移行する", "export-mode"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    actionButtons[className] = button;
    if (className === "export-mode") {
      const summary = document.createElement("div");
      summary.className = "log-summary";
      const count = document.createElement("p");
      count.textContent = "ログを読み込み中...";
      count.setAttribute("aria-live", "polite");
      const note = document.createElement("p");
      note.textContent = "※最新の20件のみを表示しております";
      const status = document.createElement("p");
      status.setAttribute("aria-live", "polite");
      summary.appendChild(count);
      summary.appendChild(note);
      summary.appendChild(status);
      actions.appendChild(summary);
      actionButtons.count = count;
      actionButtons.status = status;
    }
    actions.appendChild(button);
  }
  panel.appendChild(title);
  panel.appendChild(actions);
  const logList = document.createElement("ol");
  logList.className = "log-list";
  logList.setAttribute("aria-label", "追加したログ");
  panel.appendChild(logList);

  const sidebarStateKey = "leci-aca-log-getter-sidebar-open";
  let isOpen = false;
  try {
    isOpen = sessionStorage.getItem(sidebarStateKey) === "true";
  } catch (error) {
    console.error("フレームの開閉状態の読み込みに失敗しました:", error);
    alert("フレームの開閉状態を読み込めませんでした。");
  }
  function updateSidebarState() {
    host.toggleAttribute("data-open", isOpen);
    panel.inert = !isOpen;
    panel.setAttribute("aria-hidden", String(!isOpen));
    toggle.textContent = isOpen ? ">" : "<";
    toggle.setAttribute("aria-label", isOpen ? "フレームを閉じる" : "フレームを開く");
    toggle.setAttribute("aria-expanded", String(isOpen));
  }
  updateSidebarState();
  toggle.addEventListener("click", () => {
    isOpen = !isOpen;
    updateSidebarState();
    try {
      sessionStorage.setItem(sidebarStateKey, String(isOpen));
    } catch (error) {
      console.error("フレームの開閉状態の保存に失敗しました:", error);
      alert("フレームの開閉状態を保存できませんでした。ページ移動後に状態が維持されない場合があります。");
    }
  });

  shadow.appendChild(style);
  shadow.appendChild(toggle);
  shadow.appendChild(panel);
  document.body.appendChild(host);
  return { logList, host, ...actionButtons };
}

const ui = insertSidebar();
ui.progress = insertProgressDialog();
ui["add-all"].addEventListener("click", () => {
  if (ui.progress.dialog.open) {
    return;
  }
  const messages = Array.from(document.querySelectorAll('section.room-message[id^="message-"]'));
  ui.progress.show(true);
  ui["add-all"].disabled = true;
  return enqueueLogTask(async () => {
    try {
      messages.sort((a, b) => {
        const left = BigInt(messageId(a));
        const right = BigInt(messageId(b));
        return left < right ? -1 : left > right ? 1 : 0;
      });
      const pending = [];
      const seen = new Set();
      for (const message of messages) {
        const id = messageId(message);
        if (!seen.has(id)) {
          seen.add(id);
          if (!await logRequest("log-contains", { messageId: id })) {
            pending.push(message);
          }
        }
      }
      let total = pending.length;
      let remaining = total;
      let added = 0;
      ui.progress.update(total, remaining);
      for (const message of pending) {
        if (await addMessage(message, ui.host, ui.progress.dialog)) {
          added++;
        } else {
          total--;
        }
        remaining--;
        ui.progress.update(total, remaining);
        await refreshLogs(ui);
      }
      ui.status.textContent = `${added}件のログを追加しました。`;
      await refreshLogs(ui);
    } finally {
      ui["add-all"].disabled = false;
      ui.progress.close();
    }
  });
});
ui["delete-all"].addEventListener("click", () => {
  if (!confirm("取得したログをすべて削除しますか？")) {
    return;
  }
  return enqueueLogTask(async () => {
    await logRequest("log-clear");
    ui.status.textContent = "ログをすべて削除しました。";
    await refreshLogs(ui);
  });
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "logs-changed") {
    refreshLogs(ui).catch((error) => {
      console.error("ログ一覧の更新に失敗しました:", error);
      ui.status.textContent = `ログ一覧の更新に失敗しました: ${error.message}`;
    });
  }
});
refreshLogs(ui).catch((error) => {
  console.error("ログ一覧の読み込みに失敗しました:", error);
  ui.count.textContent = "ログの読み込みに失敗しました。";
  ui.status.textContent = error.message;
});
insertLogButtons(ui);

const observer = new MutationObserver(() => {
  insertLogButtons(ui);
});
observer.observe(document.documentElement, { childList: true, subtree: true });
