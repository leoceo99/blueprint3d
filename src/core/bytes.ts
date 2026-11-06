/** 이진 자료 ↔ 글자 바꾸기 (base64, data URL) */
export function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(s: string): ArrayBuffer {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b.buffer;
}

/** "data:image/png;base64,...." → { mime, bytes }. data URL이 아니면 null */
export function parseDataUrl(s: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(s);
  if (!m) return null;
  const bytes = m[2] ? new Uint8Array(fromBase64(m[3])) : new TextEncoder().encode(decodeURIComponent(m[3]));
  return { mime: m[1], bytes };
}

export const toDataUrl = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${toBase64(bytes)}`;
