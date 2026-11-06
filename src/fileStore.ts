/**
 * 큰 파일(가져온 3D 파일, 밑그림 이미지)을 IndexedDB에 보관. localStorage(약 5MB)에 넣기엔 커서 따로 둔다.
 * 여러 프로젝트·버전이 같은 파일을 가리킬 수 있어서, 아무도 가리키지 않는 파일만 정리(gcFiles)한다.
 * IndexedDB를 쓸 수 없는 환경이면 이번 세션 동안만 메모리에 둔다.
 */
import { idbDelete, idbGet, idbKeys, idbPut } from "./db";

const memory = new Map<string, ArrayBuffer | string>();

export async function putFile(key: string, data: ArrayBuffer | string): Promise<void> {
  memory.set(key, data);
  try {
    await idbPut("files", data, key);
  } catch {
    /* 메모리에만 */
  }
}

export async function getFile(key: string): Promise<ArrayBuffer | null> {
  const v = await getAny(key);
  return v instanceof ArrayBuffer ? v : null;
}

export async function getText(key: string): Promise<string | null> {
  const v = await getAny(key);
  return typeof v === "string" ? v : null;
}

export function memoryText(key: string): string | null {
  const v = memory.get(key);
  return typeof v === "string" ? v : null;
}

async function getAny(key: string): Promise<ArrayBuffer | string | null> {
  if (memory.has(key)) return memory.get(key)!;
  try {
    const v = await idbGet<ArrayBuffer | string>("files", key);
    if (v !== undefined) memory.set(key, v);
    return v ?? null;
  } catch {
    return null;
  }
}

/** keep에 없는 파일을 지운다 (보관함 정리할 때) */
export async function gcFiles(keep: Set<string>): Promise<number> {
  let n = 0;
  try {
    for (const k of await idbKeys("files")) {
      if (typeof k === "string" && !keep.has(k)) {
        await idbDelete("files", k);
        memory.delete(k);
        n++;
      }
    }
  } catch {
    /* 무시 */
  }
  return n;
}
