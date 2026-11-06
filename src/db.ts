/**
 * 브라우저 IndexedDB: 프로젝트 보관함, 버전 기록, 큰 파일(가져온 3D, 밑그림 이미지).
 * 버전 1: files  /  버전 2: + projects, versions
 */
const NAME = "blueprint3d";
const VERSION = 2;
export type StoreName = "files" | "projects" | "versions";

let dbp: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB 없음"));
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("versions")) {
        const s = db.createObjectStore("versions", { keyPath: "id" });
        s.createIndex("byProject", "projectId");
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 다른 탭이 새 버전으로 올리면 닫고 다시 연다
      db.onversionchange = () => {
        db.close();
        dbp = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbp = null;
      reject(req.error);
    };
    req.onblocked = () => console.warn("IndexedDB 업그레이드가 다른 탭 때문에 기다리는 중");
  });
  return dbp;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const r = fn(t.objectStore(store));
        t.oncomplete = () => resolve(r.result);
        t.onerror = () => reject(t.error ?? r.error);
        t.onabort = () => reject(t.error ?? new Error("저장이 취소되었습니다"));
      }),
  );
}

export const idbGet = <T>(store: StoreName, key: IDBValidKey) => run<T | undefined>(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
export const idbPut = (store: StoreName, value: unknown, key?: IDBValidKey) => run(store, "readwrite", (s) => s.put(value, key));
export const idbDelete = (store: StoreName, key: IDBValidKey) => run(store, "readwrite", (s) => s.delete(key));
export const idbAll = <T>(store: StoreName) => run<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
export const idbKeys = (store: StoreName) => run<IDBValidKey[]>(store, "readonly", (s) => s.getAllKeys());
export const idbByIndex = <T>(store: StoreName, index: string, key: IDBValidKey) =>
  run<T[]>(store, "readonly", (s) => s.index(index).getAll(key) as IDBRequest<T[]>);
