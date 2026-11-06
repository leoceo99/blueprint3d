/**
 * 큰 파일(가져온 3D 파일)을 브라우저 IndexedDB에 보관. localStorage(약 5MB)에 넣기엔 커서 따로 둔다.
 * IndexedDB를 쓸 수 없는 환경이면 이번 세션 동안만 메모리에 둔다.
 */
const DB = "blueprint3d";
const STORE = "files";
const memory = new Map<string, ArrayBuffer>();

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function putFile(key: string, data: ArrayBuffer): Promise<void> {
  memory.set(key, data);
  try {
    // 한 번에 하나만 보관 (예전 파일은 지운다)
    const keys = (await tx("readonly", (s) => s.getAllKeys())) as string[];
    for (const k of keys) if (k !== key) await tx("readwrite", (s) => s.delete(k));
    await tx("readwrite", (s) => s.put(data, key));
  } catch {
    /* 메모리에만 */
  }
}

export async function getFile(key: string): Promise<ArrayBuffer | null> {
  if (memory.has(key)) return memory.get(key)!;
  try {
    const v = (await tx("readonly", (s) => s.get(key))) as ArrayBuffer | undefined;
    if (v) memory.set(key, v);
    return v ?? null;
  } catch {
    return null;
  }
}
