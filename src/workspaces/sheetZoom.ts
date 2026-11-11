/**
 * 도면 출력 화면 확대·이동 (12.4·12.5): Ctrl+바퀴(트랙패드 두 손가락 벌리기 포함)·두 손가락·＋/− 단추로 확대,
 * 빈 곳을 한 손가락으로 끌거나 스크롤로 이동. 확대한 상태는 도면을 다시 그려도 유지된다.
 */
let zoom = 1;
const MIN = 0.5;
const MAX = 8;

export const sheetZoom = () => zoom;

/** 호스트 크기 (크기가 바뀔 때만 다시 잼 — 도면을 다시 그릴 때 레이아웃을 강제로 계산하지 않게, 14.8) */
let hostSize: [number, number] | null = null;

/** 맞춤 크기(1배)일 때 도면 너비 (화면 px) */
function fitWidth(host: HTMLElement, svg: SVGSVGElement): number {
  const vb = svg.viewBox.baseVal;
  const aspect = vb.width / (vb.height || 1);
  const [cw, ch] = hostSize ?? [host.clientWidth, host.clientHeight];
  return Math.max(200, Math.min(cw - 48, (ch - 48) * aspect));
}

/** 새로 그린 도면에 지금 배율 크기만 입힘 (읽기 없음 — 스크롤 자리는 부르는 쪽이 그대로 둠) */
export function sizeSvg(host: HTMLElement, svg: SVGSVGElement) {
  svg.style.width = `${fitWidth(host, svg) * zoom}px`;
  svg.style.height = "auto";
  svg.style.maxWidth = "none";
  svg.style.maxHeight = "none";
  document.querySelector("#sheetZoomLabel")!.textContent = `${Math.round(zoom * 100)}%`;
}

/** 지금 배율로 도면 크기 맞추기. at: 이 화면 점(호스트 기준) 아래가 그대로 있게 */
export function applyZoom(host: HTMLElement, svg: SVGSVGElement, next = zoom, at?: [number, number]) {
  const oldW = svg.getBoundingClientRect().width || 1;
  const rect = svg.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const anchor = at ?? [host.clientWidth / 2, host.clientHeight / 2];
  // 기준점이 도면의 어디(비율)인지
  const fx = (hostRect.left + anchor[0] - rect.left) / oldW;
  const fy = (hostRect.top + anchor[1] - rect.top) / (rect.height || 1);
  zoom = Math.min(MAX, Math.max(MIN, next));
  const w = fitWidth(host, svg) * zoom;
  svg.style.width = `${w}px`;
  svg.style.height = "auto";
  svg.style.maxWidth = "none";
  svg.style.maxHeight = "none";
  const r2 = svg.getBoundingClientRect();
  host.scrollLeft += r2.left + fx * r2.width - (hostRect.left + anchor[0]);
  host.scrollTop += r2.top + fy * r2.height - (hostRect.top + anchor[1]);
  document.querySelector("#sheetZoomLabel")!.textContent = `${Math.round(zoom * 100)}%`;
}

export function zoomBy(host: HTMLElement, k: number, at?: [number, number]) {
  const svg = host.querySelector("svg");
  if (svg) applyZoom(host, svg, zoom * k, at);
}

export function zoomFit(host: HTMLElement) {
  const svg = host.querySelector("svg");
  if (!svg) return;
  zoom = 1;
  applyZoom(host, svg, 1);
  host.scrollLeft = 0;
  host.scrollTop = 0;
}

/** 빈 곳 끌기로 이동 (치수 편집기가 손가락·가운데 단추에서 부름) */
export function panBy(host: HTMLElement, dx: number, dy: number) {
  host.scrollLeft -= dx;
  host.scrollTop -= dy;
}

let wired = false;
/** 호스트에 한 번: 바퀴·두 손가락 */
export function wireZoom(host: HTMLElement) {
  if (wired) return;
  wired = true;
  // 창·패널 크기가 바뀌면 크기를 기억하고 도면도 맞춤
  if (typeof ResizeObserver === "function")
    new ResizeObserver(() => {
      // 숨겨져 있으면(다른 작업 공간) 0 — 기억하지 않음
      if (!host.clientWidth) return;
      hostSize = [host.clientWidth, host.clientHeight];
      const svg = host.querySelector("svg");
      if (svg) sizeSvg(host, svg);
    }).observe(host);
  host.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return; // 그냥 바퀴는 스크롤 (이동)
      e.preventDefault();
      const r = host.getBoundingClientRect();
      zoomBy(host, Math.exp(-e.deltaY * 0.01), [e.clientX - r.left, e.clientY - r.top]);
    },
    { passive: false },
  );
  // 두 손가락: 벌리고 오므리기 = 확대, 함께 끌기 = 이동
  const touches = new Map<number, [number, number]>();
  let pinch: { d0: number; z0: number; m0: [number, number] } | null = null;
  const mid = (): [number, number] => {
    const [a, b] = [...touches.values()];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  host.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType !== "touch") return;
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        pinch = { d0: Math.max(10, Math.hypot(b[0] - a[0], b[1] - a[1])), z0: zoom, m0: mid() };
        e.stopPropagation(); // 치수 편집기에는 안 보냄
      }
    },
    true,
  );
  host.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (!pinch || touches.size < 2) return;
      e.stopPropagation();
      const [a, b] = [...touches.values()];
      const d = Math.max(10, Math.hypot(b[0] - a[0], b[1] - a[1]));
      const m = mid();
      const r = host.getBoundingClientRect();
      const svg = host.querySelector("svg");
      if (svg) applyZoom(host, svg, (pinch.z0 * d) / pinch.d0, [m[0] - r.left, m[1] - r.top]);
      panBy(host, m[0] - pinch.m0[0], m[1] - pinch.m0[1]);
      pinch.m0 = m;
    },
    true,
  );
  const end = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
  };
  host.addEventListener("pointerup", end, true);
  host.addEventListener("pointercancel", end, true);
  window.addEventListener("resize", () => {
    const svg = host.querySelector("svg");
    if (svg) applyZoom(host, svg);
  });
}
