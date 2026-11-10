importScripts("log-storage.js");

let captureQueue = Promise.resolve();
let lastCaptureTime = 0;

async function captureTab(tab) {
  const wait = Math.max(0, 550 - (Date.now() - lastCaptureTime));
  if (wait) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  let changed = false;
  const onActivated = (info) => {
    if (info.windowId === tab.windowId && info.tabId !== tab.id) {
      changed = true;
    }
  };
  const onFocusChanged = (windowId) => {
    if (windowId !== tab.windowId) {
      changed = true;
    }
  };
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.windows.onFocusChanged.addListener(onFocusChanged);
  try {
    const active = await chrome.tabs.get(tab.id);
    const window = await chrome.windows.get(tab.windowId);
    if (!active.active || !window.focused || changed) {
      throw new Error("投稿のタブを表示したまま撮影してください。");
    }

    lastCaptureTime = Date.now();
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const current = await chrome.tabs.get(tab.id);
    const currentWindow = await chrome.windows.get(tab.windowId);
    if (!current.active || !currentWindow.focused || changed) {
      throw new Error("撮影中にタブまたはウィンドウが切り替わりました。");
    }
    return image;
  } finally {
    chrome.tabs.onActivated.removeListener(onActivated);
    chrome.windows.onFocusChanged.removeListener(onFocusChanged);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const types = [
    "capture-log-image", "log-contains", "log-add", "log-list", "log-remove", "log-clear", "log-list-all",
    "output-list", "output-items", "output-create", "output-rename", "output-delete",
    "output-dummy", "output-move", "output-move-all", "output-item-remove", "output-item-reorder",
  ];
  if (!types.includes(message?.type)) {
    return;
  }
  const tab = sender.tab;
  let url;
  try {
    url = new URL(sender.url);
  } catch {
    sendResponse({ error: "撮影元のURLが不正です。" });
    return;
  }
  if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId) ||
      sender.frameId !== 0 || url.origin !== "https://rarirupj.com" ||
      !url.pathname.startsWith("/leciar/room")) {
    sendResponse({ error: "このページからは撮影できません。" });
    return;
  }

  if (message.type === "capture-log-image") {
    const job = captureQueue.then(() => captureTab(tab));
    captureQueue = job.catch(() => {});
    job.then((image) => sendResponse({ image }), (error) => {
      sendResponse({ error: `画面キャプチャに失敗しました: ${error.message}` });
    });
    return true;
  }
  if (["log-contains", "log-add", "log-remove", "output-move"].includes(message.type) &&
      (typeof message.messageId !== "string" || !/^\d+$/.test(message.messageId))) {
    sendResponse({ error: "投稿IDが不正です。" });
    return;
  }
  if (message.type === "log-add" && typeof message.html !== "string") {
    sendResponse({ error: "投稿内容が不正です。" });
    return;
  }
  if (["output-items", "output-rename", "output-delete", "output-dummy", "output-move", "output-move-all",
    "output-item-remove", "output-item-reorder"].includes(message.type) &&
      (!Number.isSafeInteger(message.outputId) || message.outputId < 1)) {
    sendResponse({ error: "出力ログIDが不正です。" });
    return;
  }
  if (["output-item-remove", "output-item-reorder"].includes(message.type) &&
      (!Number.isSafeInteger(message.itemId) || message.itemId < 1)) {
    sendResponse({ error: "出力ログの項目IDが不正です。" });
    return;
  }
  if (message.type === "output-item-reorder" && message.direction !== -1 && message.direction !== 1) {
    sendResponse({ error: "移動方向が不正です。" });
    return;
  }
  if (["output-create", "output-rename"].includes(message.type) &&
      (typeof message.name !== "string" || !message.name.trim())) {
    sendResponse({ error: "ログ名称を入力してください。" });
    return;
  }
  if (message.type === "output-dummy" &&
      (typeof message.text !== "string" || !message.text.trim())) {
    sendResponse({ error: "ダミー投稿の内容を入力してください。" });
    return;
  }
  const operations = {
    "log-contains": () => LogStorage.contains(message.messageId),
    "log-add": () => LogStorage.add(message.messageId, message.html),
    "log-list": () => LogStorage.list(),
    "log-remove": () => LogStorage.remove(message.messageId),
    "log-clear": () => LogStorage.clear(),
    "log-list-all": () => LogStorage.listAll(),
    "output-list": () => LogStorage.listOutputs(),
    "output-items": () => LogStorage.listOutputItems(message.outputId),
    "output-create": () => LogStorage.createOutput(message.name.trim()),
    "output-rename": () => LogStorage.renameOutput(message.outputId, message.name.trim()),
    "output-delete": () => LogStorage.deleteOutput(message.outputId),
    "output-dummy": () => LogStorage.addDummy(message.outputId, message.text),
    "output-move": () => LogStorage.copyToOutput(message.outputId, message.messageId),
    "output-move-all": () => LogStorage.copyToOutput(message.outputId),
    "output-item-remove": () => LogStorage.removeOutputItem(message.outputId, message.itemId),
    "output-item-reorder": () => LogStorage.reorderOutputItem(message.outputId, message.itemId, message.direction),
  };
  operations[message.type]().then(async (value) => {
    if (["log-add", "log-remove", "log-clear", "output-create", "output-rename",
      "output-delete", "output-dummy", "output-move", "output-move-all",
      "output-item-remove", "output-item-reorder"].includes(message.type) &&
        !(message.type === "log-add" && !value)) {
      try {
        const tabs = await chrome.tabs.query({ url: "https://rarirupj.com/leciar/room*" });
        await Promise.all(tabs.filter((target) => target.id !== undefined).map((target) =>
          chrome.tabs.sendMessage(target.id, { type: "logs-changed" }).catch((error) => {
            console.info("ログ更新通知を送れませんでした:", error.message);
          })
        ));
      } catch (error) {
        console.error("ログ更新通知に失敗しました:", error);
      }
    }
    sendResponse({ value });
  }, (error) => sendResponse({ error: `ログの保存操作に失敗しました: ${error.message}` }));
  return true;
});
