const DB_NAME = "fmt-flightlog";
const DB_VERSION = 1;
const STORE_NAME = "logs";
const LAST_LOG_KEY = "last-log";

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("当前浏览器不支持 IndexedDB 缓存"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("打开缓存数据库失败"));
  });
}

async function withStore(mode, callback) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);

    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error("缓存操作失败"));
    };

    try {
      callback(store, resolve, reject);
    } catch (error) {
      db.close();
      reject(error);
    }
  });
}

export async function saveLastLog({ name, size, type, lastModified, buffer }) {
  await withStore("readwrite", (store, resolve, reject) => {
    const request = store.put(
      {
        name,
        size,
        type,
        lastModified,
        savedAt: Date.now(),
        buffer,
      },
      LAST_LOG_KEY,
    );

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("保存缓存失败"));
  });
}

export async function loadLastLog() {
  return withStore("readonly", (store, resolve, reject) => {
    const request = store.get(LAST_LOG_KEY);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error ?? new Error("读取缓存失败"));
  });
}

export async function clearLastLog() {
  await withStore("readwrite", (store, resolve, reject) => {
    const request = store.delete(LAST_LOG_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("清除缓存失败"));
  });
}
