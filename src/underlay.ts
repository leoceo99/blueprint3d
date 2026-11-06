/**
 * 밑그림 이미지 보관: 브라우저 저장소(localStorage)에 한 장만 두고, 화면 색에 맞춰 물들인 캔버스를 캐시한다.
 * 이미지는 선 = 불투명, 바탕 = 투명인 PNG.
 */
const PREFIX = "blueprint3d.underlay.";
const memory = new Map<string, string>();
const images = new Map<string, HTMLImageElement>();
const tinted = new Map<string, HTMLCanvasElement>();
let onReady: (() => void) | null = null;

/** 이미지가 늦게 읽히면 화면을 다시 그리도록 */
export function onUnderlayReady(fn: () => void) {
  onReady = fn;
}

export function putUnderlay(key: string, dataUrl: string) {
  memory.set(key, dataUrl);
  try {
    // 한 장만 남긴다
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX) && k !== PREFIX + key) localStorage.removeItem(k);
    }
    localStorage.setItem(PREFIX + key, dataUrl);
  } catch {
    /* 저장 공간이 모자라면 이번 세션 동안만 */
  }
}

export function getUnderlayData(key: string): string | null {
  if (memory.has(key)) return memory.get(key)!;
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

/** 색을 입힌 밑그림 캔버스 (아직 읽는 중이면 null) */
export function underlayCanvas(key: string, color: string): HTMLCanvasElement | null {
  const tk = key + "|" + color;
  if (tinted.has(tk)) return tinted.get(tk)!;
  let img = images.get(key);
  if (!img) {
    const src = getUnderlayData(key);
    if (!src) return null;
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
