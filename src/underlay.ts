/**
 * 밑그림 이미지 보관: IndexedDB(fileStore)에 프로젝트마다 한 장씩 두고, 화면 색에 맞춰 물들인 캔버스를 캐시한다.
 * 이미지는 선 = 불투명, 바탕 = 투명인 PNG(data URL). (예전에는 localStorage에 한 장만 두었다 → 처음 읽을 때 옮긴다)
 */
import { getText, memoryText, putFile } from "./fileStore";

const LEGACY = "blueprint3d.underlay.";
const images = new Map<string, HTMLImageElement>();
const tinted = new Map<string, HTMLCanvasElement>();
const loading = new Set<string>();
let onReady: (() => void) | null = null;

/** 이미지가 늦게 읽히면 화면을 다시 그리도록 */
export function onUnderlayReady(fn: () => void) {
  onReady = fn;
}

export function putUnderlay(key: string, dataUrl: string) {
  void putFile(key, dataUrl);
}

/** 지금 메모리에 있는 밑그림 (없으면 null — loadUnderlay로 읽어 온다) */
export function getUnderlayData(key: string): string | null {
  return memoryText(key);
}

/** 저장소에서 읽기 (예전 localStorage에 있으면 옮긴다) */
export async function loadUnderlay(key: string): Promise<string | null> {
  let v = await getText(key);
  if (!v) {
    try {
      v = localStorage.getItem(LEGACY + key);
      if (v) {
        await putFile(key, v);
        localStorage.removeItem(LEGACY + key);
      }
    } catch {
      /* 무시 */
    }
  }
  return v;
}

/** 색을 입힌 밑그림 캔버스 (아직 읽는 중이면 null) */
export function underlayCanvas(key: string, color: string): HTMLCanvasElement | null {
  const tk = key + "|" + color;
  if (tinted.has(tk)) return tinted.get(tk)!;
  let img = images.get(key);
  if (!img) {
    const src = getUnderlayData(key);
    if (!src) {
      if (!loading.has(key)) {
        loading.add(key);
        loadUnderlay(key).then((v) => v && onReady?.());
      }
      return null;
    }
    img = new Image();
    img.onload = () => onReady?.();
    img.src = src;
    images.set(key, img);
  }
  if (!img.complete || !img.naturalWidth) return null;
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  tinted.set(tk, c);
  return c;
}

/** 선 마스크 → 투명 바탕 PNG (긴 변 maxSide 이하로 줄여서) */
export function maskToDataUrl(ink: Uint8Array, w: number, h: number, maxSide = 2400): string {
  const full = document.createElement("canvas");
  full.width = w;
  full.height = h;
  const ctx = full.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const a = ink[i] ? 255 : 0;
    img.data[i * 4 + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
  const k = Math.min(1, maxSide / Math.max(w, h));
  if (k >= 1) return full.toDataURL("image/png");
  const small = document.createElement("canvas");
  small.width = Math.round(w * k);
  small.height = Math.round(h * k);
  const sc = small.getContext("2d")!;
  sc.imageSmoothingQuality = "high";
  sc.drawImage(full, 0, 0, small.width, small.height);
  return small.toDataURL("image/png");
}
