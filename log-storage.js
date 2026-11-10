const LogStorage = (() => {
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("LeciAcaLogGetter", 2);
      let blocked = false;
      request.onupgradeneeded = (event) => {
        const database = request.result;
        if (event.oldVersion < 1) {
          const store = database.createObjectStore("logs", { keyPath: "sequence", autoIncrement: true });
          store.createIndex("messageId", "messageId", { unique: true });
        }
        if (event.oldVersion < 2) {
          database.createObjectStore("outputLogs", { keyPath: "id", autoIncrement: true });
          const items = database.createObjectStore("outputItems", { keyPath: "id", autoIncrement: true });
          items.createIndex("outputId", "outputId");
          items.createIndex("outputMessage", ["outputId", "messageId"], { unique: true });
        }
      };
      request.onsuccess = () => {
        if (blocked) {
          request.result.close();
        } else {
          resolve(request.result);
        }
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error("ログデータベースを開けません。他のタブを閉じてください。"));
      };
    });
  }

  async function transactionStores(stores, mode, run) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(stores, mode);
      let result;
      let reason;
      tx.oncomplete = () => { database.close(); resolve(result); };
      tx.onabort = () => { database.close(); reject(reason || tx.error || new Error("ログの操作が中断されました。")); };
      try {
        run(tx, (value) => { result = value; }, (error) => { reason = error; tx.abort(); });
      } catch (error) {
        reason = error;
        tx.abort();
      }
    });
  }

  function transaction(mode, run) {
    return transactionStores(["logs"], mode, (tx, setResult) => run(tx.objectStore("logs"), setResult));
  }

  function contains(messageId) {
    return transaction("readonly", (store, setResult) => {
      const request = store.index("messageId").getKey(messageId);
      request.onsuccess = () => setResult(request.result !== undefined);
    });
  }

  function add(messageId, html) {
    return transaction("readwrite", (store, setResult) => {
      const request = store.add({ messageId, html });
      request.onsuccess = () => setResult(true);
      request.onerror = (event) => {
        if (request.error?.name === "ConstraintError") {
          event.preventDefault();
          setResult(false);
        }
      };
    });
  }

  function list() {
    return transaction("readonly", (store, setResult) => {
      const result = { count: 0, entries: [] };
      const count = store.count();
      count.onsuccess = () => { result.count = count.result; };
      const cursor = store.openCursor(null, "prev");
      cursor.onsuccess = () => {
        if (cursor.result && result.entries.length < 20) {
          result.entries.push(cursor.result.value);
          cursor.result.continue();
        }
      };
      setResult(result);
    });
  }

  function remove(messageId) {
    return transaction("readwrite", (store) => {
      const request = store.index("messageId").getKey(messageId);
      request.onsuccess = () => {
        if (request.result !== undefined) {
          store.delete(request.result);
        }
      };
    });
  }

  function clear() {
    return transaction("readwrite", (store) => { store.clear(); });
  }

  function listAll() {
    return transaction("readonly", (store, setResult) => {
      const request = store.getAll();
      request.onsuccess = () => setResult(request.result);
    });
  }

  function listOutputs() {
    return transactionStores(["outputLogs"], "readonly", (tx, setResult) => {
      const request = tx.objectStore("outputLogs").getAll();
      request.onsuccess = () => setResult(request.result);
    });
  }

  function listOutputItems(outputId) {
    return transactionStores(["outputLogs", "outputItems"], "readonly", (tx, setResult, fail) => {
      const output = tx.objectStore("outputLogs").get(outputId);
      output.onsuccess = () => {
        if (!output.result) {
          fail(new Error("出力ログが見つかりません。"));
          return;
        }
        const request = tx.objectStore("outputItems").index("outputId").getAll(outputId);
        request.onsuccess = () => setResult(request.result.sort((a, b) => a.order - b.order));
      };
    });
  }

  function createOutput(name) {
    return transactionStores(["outputLogs"], "readwrite", (tx, setResult) => {
      const request = tx.objectStore("outputLogs").add({ name, count: 0, nextTop: -1, nextBottom: 0 });
      request.onsuccess = () => setResult(request.result);
    });
  }

  function updateOutput(outputId, update) {
    return transactionStores(["outputLogs", "outputItems"], "readwrite", (tx, setResult, fail) => {
      const outputs = tx.objectStore("outputLogs");
      const request = outputs.get(outputId);
      request.onsuccess = () => {
        if (!request.result) {
          fail(new Error("出力ログが見つかりません。"));
          return;
        }
        update(request.result, outputs, tx.objectStore("outputItems"), setResult, fail);
      };
    });
  }

  function renameOutput(outputId, name) {
    return updateOutput(outputId, (output, outputs) => {
      output.name = name;
      outputs.put(output);
    });
  }

  function deleteOutput(outputId) {
    return updateOutput(outputId, (output, outputs, items) => {
      const request = items.index("outputId").openKeyCursor(outputId);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          items.delete(cursor.primaryKey);
          cursor.continue();
        }
      };
      outputs.delete(output.id);
    });
  }

  function addDummy(outputId, text) {
    return updateOutput(outputId, (output, outputs, items) => {
      items.add({ outputId, order: output.nextTop--, type: "dummy", text });
      output.count++;
      outputs.put(output);
    });
  }

  function removeOutputItem(outputId, itemId) {
    return updateOutput(outputId, (output, outputs, items, setResult, fail) => {
      const request = items.get(itemId);
      request.onsuccess = () => {
        if (!request.result || request.result.outputId !== outputId) {
          fail(new Error("出力ログの項目が見つかりません。"));
          return;
        }
        items.delete(itemId);
        output.count--;
        outputs.put(output);
      };
    });
  }

  function reorderOutputItem(outputId, itemId, direction) {
    return updateOutput(outputId, (output, outputs, items, setResult, fail) => {
      const request = items.index("outputId").getAll(outputId);
      request.onsuccess = () => {
        const entries = request.result.sort((a, b) => a.order - b.order);
        const index = entries.findIndex((entry) => entry.id === itemId);
        if (index === -1) {
          fail(new Error("出力ログの項目が見つかりません。"));
          return;
        }
        const neighbor = entries[index + direction];
        if (!neighbor) {
          setResult(false);
          return;
        }
        const entry = entries[index];
        [entry.order, neighbor.order] = [neighbor.order, entry.order];
        items.put(entry);
        items.put(neighbor);
        setResult(true);
      };
    });
  }

  function copyToOutput(outputId, messageId) {
    return transactionStores(["logs", "outputLogs", "outputItems"], "readwrite", (tx, setResult, fail) => {
      const logs = tx.objectStore("logs");
      const outputs = tx.objectStore("outputLogs");
      const items = tx.objectStore("outputItems");
      const outputRequest = outputs.get(outputId);
      outputRequest.onsuccess = () => {
        const output = outputRequest.result;
        if (!output) {
          fail(new Error("出力ログが見つかりません。"));
          return;
        }
        const source = messageId === undefined ? logs.getAll() : logs.index("messageId").get(messageId);
        source.onsuccess = () => {
          if (messageId !== undefined && !source.result) {
            fail(new Error("収集ログが見つかりません。"));
            return;
          }
          const entries = messageId === undefined ? source.result : [source.result];
          entries.sort((a, b) => {
            const left = BigInt(a.messageId);
            const right = BigInt(b.messageId);
            return left < right ? -1 : left > right ? 1 : 0;
          });
          const result = { moved: 0, skipped: 0 };
          setResult(result);
          for (const entry of entries) {
            const existing = items.index("outputMessage").getKey([outputId, entry.messageId]);
            existing.onsuccess = () => {
              if (existing.result !== undefined) {
                result.skipped++;
                return;
              }
              items.add({
                outputId, order: output.nextBottom++, type: "post",
                messageId: entry.messageId, html: entry.html,
              });
              output.count++;
              result.moved++;
              outputs.put(output);
            };
          }
        };
      };
    });
  }

  return {
    contains, add, list, remove, clear, listAll, listOutputs, listOutputItems,
    createOutput, renameOutput, deleteOutput, addDummy, copyToOutput,
    removeOutputItem, reorderOutputItem,
  };
})();
