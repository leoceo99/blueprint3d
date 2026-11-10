/**
 * 도면 출력 화면의 치수 편집 (11.3).
 *   치수 도구: 점 두 개 → 가로·세로(커서 쪽으로 알아서)·평행 치수, 원·원호 → Ø·R, 선 두 개 → 각도. 마지막 누름이 치수선 자리.
 *   선택 도구: 치수 누르기 → 고르기, 끌기 → 옮기기, 두 번 누르기 → 글자 덧붙이기(공차 등), Delete → 지우기(자동 치수는 숨기기).
 * 터치·펜도 같은 길(pointer 이벤트), 손가락이면 잡히는 거리를 넓게 (원칙 10).
 * 바뀐 것은 도면(Drawing.edits)에 저장되어 실행 취소된다.
 */
import type { DimEdits, Sheet } from "../core/sheet";
import { fragmentSVG } from "../core/sheet";
import { renderDim, type DimDraw, type Pt, type SheetDim } from "../core/sheetDims";
import type { ViewId as StdView } from "../core/types";
/** 뷰: 기본 3면도 또는 도면 추가 뷰 id */
type ViewId = string;
import { fmtLen } from "../core/units";
import { panBy } from "./sheetZoom";

import { sheetEdit, type EditorHost } from "./sheetState";
import { nextLabel, type DrawingView } from "../core/sheetViews";

const isStdView = (v: string) => v === "front" || v === "top" || v === "side";
let viewSeq = 0;
const newViewId = () => `v${Date.now().toString(36).slice(-5)}${(viewSeq++).toString(36)}`;

interface Target {
  pts: { p: Pt; kind: "end" | "mid" | "center" }[];
  circles: { c: Pt; r: number; full: boolean; start: number; end: number }[];
  lines: { a: Pt; b: Pt }[];
}

const NS = "http://www.w3.org/2000/svg";
let cleanup: (() => void) | null = null;

/** 새로 그린 도면에 편집기를 붙인다 */
export function attachEditor(svg: SVGSVGElement, sh: Sheet, edits: DimEdits, host: EditorHost) {
  cleanup?.();
  const H = sh.height;
  const s = sh.scale;
  const fmt = (n: number) => fmtLen(n, sh.units);
  const overlay = document.createElementNS(NS, "g");
  overlay.setAttribute("class", "dim-overlay");
  overlay.setAttribute("font-family", "'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',system-ui,sans-serif");
  svg.appendChild(overlay);
  svg.classList.toggle("tool-dim", sheetEdit.tool !== "select");
  const tg = targets(sh);
  const manual = new Set((edits.dims ?? []).map((d) => d.id));

  // ---- 좌표 ----
  /** 그 뷰의 척도 (상세도는 도면 척도의 k배) */
  const sv = (v: ViewId) => sh.views[v]?.s ?? s;
  const toPaper = (v: ViewId, q: Pt): Pt => [sh.views[v].o[0] + q[0] * sv(v), sh.views[v].o[1] + q[1] * sv(v)];
  const toView = (v: ViewId, P: Pt): Pt => [(P[0] - sh.views[v].o[0]) / sv(v), (P[1] - sh.views[v].o[1]) / sv(v)];
  const paperOf = (e: PointerEvent | MouseEvent): Pt => {
    const m = svg.getScreenCTM();
    if (!m) return [0, 0];
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const q = pt.matrixTransform(m.inverse());
    return [q.x, H - q.y];
  };
  const tolOf = (e: PointerEvent | MouseEvent) => {
    const m = svg.getScreenCTM();
    const px = (e as PointerEvent).pointerType === "touch" ? 22 : (e as PointerEvent).pointerType === "pen" ? 14 : 9;
    return px / (m?.a || 1);
  };
  const viewAt = (P: Pt): ViewId | null => {
    for (const v of Object.keys(sh.views)) {
      const b = sh.views[v].box;
      if (P[0] >= b[0] - 4 && P[0] <= b[2] + 4 && P[1] >= b[1] - 4 && P[1] <= b[3] + 4) return v;
    }
    return null;
  };
  const draw = (d: SheetDim) => renderDim(d, (q) => toPaper(d.view, q), s, fmt);
  const group = (id: string) => svg.querySelector<SVGGElement>(`g.dim[data-dim="${CSS.escape(id)}"]`);

  // ---- 상태 ----
  let picks: { v: ViewId; q: Pt }[] = [];
  let circle: { v: ViewId; c: Pt; r: number; full: boolean } | null = null;
  let lines: { v: ViewId; a: Pt; b: Pt }[] = [];
  let hoverSnap: Pt | null = null;
  let drag: { id: string; def: SheetDim; start: Pt; moved: boolean; pointer: number } | null = null;
  /** 빈 곳 끌기 = 화면 이동 (확대했을 때, 손가락) */
  let pan: { x: number; y: number; pointer: number } | null = null;
  let preview: SheetDim | null = null;
  /** 단면·보조·상세 도구: 첫 점 (뷰 좌표) */
  let vpick: { v: ViewId; q: Pt } | null = null;
  let vhover: Pt | null = null;
  /** 추가 뷰 옮기기 */
  let vdrag: { id: string; start: Pt; now: Pt; pointer: number } | null = null;

  const reset = () => {
    vpick = null;
    vhover = null;
    picks = [];
    circle = null;
    lines = [];
    preview = null;
    paint();
  };

  const paint = () => {
    let html = "";
    if (preview) html += fragmentSVG(draw(preview).prims, draw(preview).texts, H, "var(--accent, #2563eb)");
    const mark = (P: Pt, r = 1.1) => `<circle cx="${P[0]}" cy="${H - P[1]}" r="${r}" fill="none" stroke="var(--accent, #2563eb)" stroke-width="0.35"/>`;
    for (const p of picks) html += mark(toPaper(p.v, p.q), 0.8);
    if (circle) {
      const C = toPaper(circle.v, circle.c);
      html += `<circle cx="${C[0]}" cy="${H - C[1]}" r="${circle.r * sv(circle.v)}" fill="none" stroke="var(--accent, #2563eb)" stroke-width="0.4"/>`;
    }
    for (const l of lines) {
      const A = toPaper(l.v, l.a);
      const B = toPaper(l.v, l.b);
      html += `<path d="M${A[0]} ${H - A[1]}L${B[0]} ${H - B[1]}" stroke="var(--accent, #2563eb)" stroke-width="0.5"/>`;
    }
    if (hoverSnap) html += mark(hoverSnap);
    // 단면·보조: 절단선 미리 보기, 상세: 원 미리 보기
    if (vpick && vhover) {
      const A = toPaper(vpick.v, vpick.q);
      const accent = "var(--accent, #2563eb)";
      if (sheetEdit.tool === "detail") html += `<circle cx="${A[0]}" cy="${H - A[1]}" r="${Math.hypot(vhover[0] - A[0], vhover[1] - A[1])}" fill="none" stroke="${accent}" stroke-width="0.4" stroke-dasharray="1.5 1"/>`;
      else html += `<path d="M${A[0]} ${H - A[1]}L${vhover[0]} ${H - vhover[1]}" stroke="${accent}" stroke-width="0.5" stroke-dasharray="4 1 1 1"/>`;
    }
    // 고른 추가 뷰 (옮기는 중이면 옮긴 자리)
    const selV = sheetEdit.selectedView && sh.views[sheetEdit.selectedView];
    if (selV) {
      const dx = vdrag ? vdrag.now[0] - vdrag.start[0] : 0;
      const dy = vdrag ? vdrag.now[1] - vdrag.start[1] : 0;
      const b = selV.box;
      html += `<rect x="${b[0] - 2 + dx}" y="${H - b[3] - 2 - dy}" width="${b[2] - b[0] + 4}" height="${b[3] - b[1] + 4}" fill="none" stroke="var(--accent, #2563eb)" stroke-width="0.4" stroke-dasharray="2 1"/>`;
    }
    overlay.innerHTML = html;
    for (const g of svg.querySelectorAll("g.dim.sel")) g.classList.remove("sel");
    if (sheetEdit.selected) group(sheetEdit.selected)?.classList.add("sel");
  };

  // ---- 잡을 곳 ----
  const nearestPt = (P: Pt, tol: number) => {
    let best: Pt | null = null;
    let bd = tol;
    for (const t of tg.pts) {
      const d = Math.hypot(t.p[0] - P[0], t.p[1] - P[1]);
      if (d < bd) {
        bd = d;
        best = t.p;
      }
    }
    return best;
  };
  const nearestCircle = (P: Pt, tol: number) => {
    let best: Target["circles"][number] | null = null;
    let bd = tol;
    for (const c of tg.circles) {
      const d = Math.abs(Math.hypot(P[0] - c.c[0], P[1] - c.c[1]) - c.r);
      if (d < bd && (c.full || inSweep(c, P))) {
        bd = d;
        best = c;
      }
    }
    return best;
  };
  const nearestLine = (P: Pt, tol: number) => {
    let best: Target["lines"][number] | null = null;
    let bd = tol;
    for (const l of tg.lines) {
      const d = segDist(P, l.a, l.b);
      if (d < bd) {
        bd = d;
        best = l;
      }
    }
    return best;
  };
  const dimAt = (P: Pt, tol: number): DimDraw | null => {
    let best: DimDraw | null = null;
    let area = Infinity;
    for (const d of sh.dims) {
      const b = d.box;
      if (P[0] >= b[0] - tol && P[0] <= b[2] + tol && P[1] >= b[1] - tol && P[1] <= b[3] + tol) {
        const a = (b[2] - b[0]) * (b[3] - b[1]);
        if (a < area) {
          area = a;
          best = d;
        }
      }
    }
    return best;
  };

  // ---- 치수 만들기 (커서 위치로 방향·거리) ----
  const build = (P: Pt): SheetDim | null => {
    const id = `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    if (sheetEdit.kind === "angle") {
      if (lines.length < 2) return null;
      const [l1, l2] = lines;
      const o = intersect(l1.a, l1.b, l2.a, l2.b);
      if (!o) return null;
      const far = (l: { a: Pt; b: Pt }): Pt => (Math.hypot(l.a[0] - o[0], l.a[1] - o[1]) > Math.hypot(l.b[0] - o[0], l.b[1] - o[1]) ? l.a : l.b);
      const O = toPaper(l1.v, o);
      return { id, view: l1.v, kind: "angle", o, a: far(l1), b: far(l2), rad: Math.max(4, Math.hypot(P[0] - O[0], P[1] - O[1])) };
    }
    if (circle) {
      const C = toPaper(circle.v, circle.c);
      const ang = (Math.atan2(P[1] - C[1], P[0] - C[0]) * 180) / Math.PI;
      return { id, view: circle.v, kind: circle.full ? "diameter" : "radius", c: circle.c, r: circle.r, ang, len: Math.max(2, Math.hypot(P[0] - C[0], P[1] - C[1]) - circle.r * sv(circle.v)) };
    }
    if (picks.length < 2) return null;
    const [p1, p2] = picks;
    const A = toPaper(p1.v, p1.q);
    const B = toPaper(p2.v, p2.q);
    let dir: "h" | "v" | "aligned" = sheetEdit.kind === "auto" ? "h" : sheetEdit.kind;
    if (sheetEdit.kind === "auto") {
      const oy = P[1] > Math.max(A[1], B[1]) ? P[1] - Math.max(A[1], B[1]) : P[1] < Math.min(A[1], B[1]) ? Math.min(A[1], B[1]) - P[1] : 0;
      const ox = P[0] > Math.max(A[0], B[0]) ? P[0] - Math.max(A[0], B[0]) : P[0] < Math.min(A[0], B[0]) ? Math.min(A[0], B[0]) - P[0] : 0;
      dir = oy >= ox ? "h" : "v";
      // 두 점이 가로·세로 어느 쪽으로도 나란하지 않고 커서가 그 사이면 평행
      if (!ox && !oy && Math.abs(A[0] - B[0]) > 1 && Math.abs(A[1] - B[1]) > 1) dir = "aligned";
    }
    let off: number;
    if (dir === "h") off = P[1] - A[1];
    else if (dir === "v") off = P[0] - A[0];
    else {
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
      off = ((P[0] - A[0]) * -(B[1] - A[1])) / L + ((P[1] - A[1]) * (B[0] - A[0])) / L;
    }
    return { id, view: p1.v, kind: "linear", dir, a: p1.q, b: p2.q, off };
  };

  // ---- 끌어서 옮기기 ----
  const dragged = (def: SheetDim, P0: Pt, P1: Pt): Partial<SheetDim> => {
    const dx = P1[0] - P0[0];
    const dy = P1[1] - P0[1];
    if (def.kind === "linear") {
      if (def.dir === "h") return { off: def.off + dy };
      if (def.dir === "v") return { off: def.off + dx };
      const A = toPaper(def.view, def.a);
      const B = toPaper(def.view, def.b);
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
      return { off: def.off + (dx * -(B[1] - A[1])) / L + (dy * (B[0] - A[0])) / L };
    }
    if (def.kind === "ordinate") return def.axis === "u" ? { line: def.line + dy, jog: (def.jog ?? 0) + dx } : { line: def.line + dx, jog: (def.jog ?? 0) + dy };
    if (def.kind === "radius" || def.kind === "diameter") {
      const C = toPaper(def.view, def.c);
      return { ang: (Math.atan2(P1[1] - C[1], P1[0] - C[0]) * 180) / Math.PI, len: Math.max(2, Math.hypot(P1[0] - C[0], P1[1] - C[1]) - def.r * sv(def.view)) };
    }
    if (def.kind === "angle") {
      const O = toPaper(def.view, def.o);
      return { rad: Math.max(3, Math.hypot(P1[0] - O[0], P1[1] - O[1])) };
    }
    if (def.kind === "leader") return { knee: [def.knee[0] + dx, def.knee[1] + dy] };
    return {};
  };

  const commitPatch = (id: string, patch: Partial<SheetDim>, label: string) => {
    host.edit((e) => {
      if (manual.has(id)) e.dims = (e.dims ?? []).map((d) => (d.id === id ? ({ ...d, ...patch } as SheetDim) : d));
      else e.moved = { ...(e.moved ?? {}), [id]: { ...(e.moved?.[id] ?? {}), ...patch } };
    }, label);
  };

  // ---- 입력 ----
  /** 추가 뷰 (기본 3면도가 아닌 것) 중 그 점이 안에 있는 것 */
  const extraAt = (P: Pt): string | null => {
    for (const [id, v] of Object.entries(sh.views)) {
      if (isStdView(id)) continue;
      const b = v.box;
      if (P[0] >= b[0] - 2 && P[0] <= b[2] + 2 && P[1] >= b[1] - 2 && P[1] <= b[3] + 2) return id;
    }
    return null;
  };
  /** 절단선 두 번째 점: Shift 또는 5° 안쪽이면 수평·수직으로 */
  const lockLine = (a: Pt, b: Pt, shift: boolean): Pt => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const ang = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI) % 90;
    if (shift || ang < 5 || ang > 85) return Math.abs(dx) >= Math.abs(dy) ? [b[0], a[1]] : [a[0], b[1]];
    return b;
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const P = paperOf(e);
    const tol = tolOf(e);
    if (sheetEdit.tool === "section" || sheetEdit.tool === "aux" || sheetEdit.tool === "detail") {
      e.preventDefault();
      const snap = nearestPt(P, tol) ?? P;
      const v = viewAt(snap);
      if (!vpick) {
        if (!v) return host.toast("뷰 안을 누르세요.");
        if (sheetEdit.tool !== "detail" && !isStdView(v)) return host.toast("단면·보조 투상은 정면도·평면도·우측면도 위에 그려요.");
        if (sheetEdit.tool === "detail" && sh.views[v] && (host.views().find((x) => x.id === v)?.kind ?? "section") !== "section") return host.toast("상세도는 기본 뷰나 단면도 위에 그려요.");
        vpick = { v, q: toView(v, snap) };
        paint();
        return;
      }
      const v0 = vpick.v;
      const list = host.views();
      const label = nextLabel(list);
      let view: DrawingView;
      if (sheetEdit.tool === "detail") {
        const r = Math.hypot(P[0] - toPaper(v0, vpick.q)[0], P[1] - toPaper(v0, vpick.q)[1]) / sv(v0);
        if (r * sv(v0) < 2) return host.toast("원을 조금 더 크게 그리세요.");
        view = { id: newViewId(), kind: "detail", parent: v0, c: vpick.q, r, k: 2, label };
      } else {
        const b = toView(v0, lockLine(toPaper(v0, vpick.q), snap, e.shiftKey));
        if (Math.hypot(b[0] - vpick.q[0], b[1] - vpick.q[1]) * sv(v0) < 2) return host.toast("선을 조금 더 길게 그리세요.");
        view = { id: newViewId(), kind: sheetEdit.tool === "aux" ? "aux" : "section", parent: v0 as StdView, a: vpick.q, b, label };
      }
      host.editViews((l) => [...l, view], view.kind === "section" ? `단면 ${label}-${label}` : view.kind === "aux" ? `보조 투상도 ${label}` : `상세 ${label}`);
      vpick = null;
      vhover = null;
      sheetEdit.tool = "select";
      sheetEdit.selectedView = view.id;
      host.changed();
      return;
    }
    if (sheetEdit.tool === "dim") {
      e.preventDefault();
      const ready = sheetEdit.kind === "angle" ? lines.length === 2 : picks.length === 2 || !!circle;
      if (ready) {
        const d = build(P);
        if (d) host.edit((x) => (x.dims = [...(x.dims ?? []), d]), "치수 추가");
        sheetEdit.selected = d?.id ?? null;
        reset();
        host.changed();
        return;
      }
      if (sheetEdit.kind === "angle") {
        const l = nearestLine(P, tol);
        const v = l && viewAt(l.a);
        if (!l || !v) return host.toast("각도를 잴 선을 누르세요.");
        if (lines.length && lines[0].v !== v) return host.toast("같은 뷰 안의 두 선을 누르세요.");
        lines.push({ v, a: toView(v, l.a), b: toView(v, l.b) });
        if (lines.length === 2 && !intersect(lines[0].a, lines[0].b, lines[1].a, lines[1].b)) {
          host.toast("평행한 두 선은 각도가 없어요.");
          lines.pop();
        }
        paint();
        return;
      }
      const snap = nearestPt(P, tol);
      if (snap) {
        const v = viewAt(snap);
        if (!v) return;
        if (picks.length && picks[0].v !== v) return host.toast("같은 뷰 안의 두 점을 누르세요.");
        const q = toView(v, snap);
        if (picks.length && Math.hypot(picks[0].q[0] - q[0], picks[0].q[1] - q[1]) < 1e-6) return;
        picks.push({ v, q });
      } else if (!picks.length) {
        const c = nearestCircle(P, tol);
        const v = c && viewAt(c.c);
        if (!c || !v) return host.toast("선 끝·원 중심 같은 점이나 원·원호를 누르세요.");
        circle = { v, c: toView(v, c.c), r: c.r / sv(v), full: c.full };
      }
      paint();
      return;
    }
    // 선택 도구
    const hit = dimAt(P, tol * 0.6);
    sheetEdit.selected = hit?.id ?? null;
    // 치수가 아니면: 추가 뷰 안 → 그 뷰 고르기·끌어 옮기기, 빈 곳 → 화면 이동
    const xv = hit ? null : extraAt(P);
    sheetEdit.selectedView = xv;
    if (xv) {
      vdrag = { id: xv, start: P, now: P, pointer: e.pointerId };
      try {
        svg.setPointerCapture(e.pointerId);
      } catch {
        /* 붙잡지 못해도 끌기는 됨 */
      }
    } else if (!hit) {
      pan = { x: e.clientX, y: e.clientY, pointer: e.pointerId };
      svg.style.cursor = "grabbing";
    }
    if (hit) {
      drag = { id: hit.id, def: hit.def, start: P, moved: false, pointer: e.pointerId };
      try {
        svg.setPointerCapture(e.pointerId);
      } catch {
        /* 합성 이벤트 등 — 붙잡지 못해도 끌기는 됨 */
      }
    }
    paint();
    host.changed();
  };

  const onMove = (e: PointerEvent) => {
    if (vdrag && vdrag.pointer === e.pointerId) {
      vdrag.now = paperOf(e);
      paint();
      return;
    }
    if ((sheetEdit.tool === "section" || sheetEdit.tool === "aux" || sheetEdit.tool === "detail") && vpick) {
      const P = paperOf(e);
      vhover = sheetEdit.tool === "detail" ? P : lockLine(toPaper(vpick.v, vpick.q), nearestPt(P, tolOf(e)) ?? P, e.shiftKey);
      paint();
      return;
    }
    if (pan && pan.pointer === e.pointerId) {
      panBy(svg.parentElement!, e.clientX - pan.x, e.clientY - pan.y);
      pan.x = e.clientX;
      pan.y = e.clientY;
      return;
    }
    const P = paperOf(e);
    if (drag) {
      if (!drag.moved && Math.hypot(P[0] - drag.start[0], P[1] - drag.start[1]) < 0.6) return;
      drag.moved = true;
      group(drag.id)?.setAttribute("visibility", "hidden");
      preview = { ...drag.def, ...dragged(drag.def, drag.start, P) } as SheetDim;
      paint();
      return;
    }
    if (sheetEdit.tool !== "dim") {
      const hit = dimAt(P, tolOf(e) * 0.6);
      svg.style.cursor = hit ? "move" : "";
      return;
    }
    const tol = tolOf(e);
    hoverSnap = sheetEdit.kind === "angle" ? null : nearestPt(P, tol);
    const ready = sheetEdit.kind === "angle" ? lines.length === 2 : picks.length === 2 || !!circle;
    preview = ready ? build(P) : null;
    paint();
  };

  const onUp = (e: PointerEvent) => {
    if (vdrag && vdrag.pointer === e.pointerId) {
      const d = vdrag;
      vdrag = null;
      const dx = d.now[0] - d.start[0];
      const dy = d.now[1] - d.start[1];
      const b = sh.views[d.id]?.box;
      if (b && Math.hypot(dx, dy) > 0.8) {
        const at: Pt = [(b[0] + b[2]) / 2 + dx, (b[1] + b[3]) / 2 + dy];
        host.editViews((l) => l.map((x) => (x.id === d.id ? { ...x, at } : x)), "뷰 옮기기");
      } else paint();
      host.changed();
      return;
    }
    if (pan && pan.pointer === e.pointerId) {
      pan = null;
      svg.style.cursor = "";
    }
    if (!drag || drag.pointer !== e.pointerId) return;
    const d = drag;
    drag = null;
    if (d.moved) {
      const patch = dragged(d.def, d.start, paperOf(e));
      preview = null;
      commitPatch(d.id, patch, "치수 옮기기");
    }
  };

  const onDbl = (e: MouseEvent) => {
    if (sheetEdit.tool === "dim") return;
    const hit = dimAt(paperOf(e), tolOf(e) * 0.6);
    if (!hit) return;
    const def = hit.def;
    const isLeader = def.kind === "leader";
    const cur = isLeader ? def.text : (def.suffix ?? "");
    const label = isLeader ? "지시 글자" : "덧붙일 글자 (예: ±0.1, H7, (참고))";
    editText(svg, hit, cur, label, (val) => {
      if (isLeader) commitPatch(hit.id, { text: val } as Partial<SheetDim>, "치수 글자 고치기");
      else commitPatch(hit.id, { suffix: val ? ` ${val.trim()}` : "" } as Partial<SheetDim>, "치수 글자 덧붙이기");
    });
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !svg.isConnected) return;
    if (picks.length || circle || lines.length || preview || vpick) {
      e.stopPropagation();
      reset();
    } else if (sheetEdit.tool !== "select" && sheetEdit.tool !== "dim") {
      sheetEdit.tool = "select";
      host.changed();
    } else if (sheetEdit.selected || sheetEdit.selectedView) {
      sheetEdit.selected = null;
      sheetEdit.selectedView = null;
      paint();
      host.changed();
    }
  };

  svg.addEventListener("pointerdown", onDown);
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerup", onUp);
  svg.addEventListener("pointercancel", onUp);
  svg.addEventListener("dblclick", onDbl);
  svg.addEventListener("pointerleave", () => {
    hoverSnap = null;
    if (!drag) paint();
  });
  window.addEventListener("keydown", onKey, true);
  svg.style.touchAction = "none";
  cleanup = () => window.removeEventListener("keydown", onKey, true);
  paint();
}

/** 고른 치수 지우기 (자동 치수는 숨김) */
export function deleteSelected(sh: Sheet | null, edits: DimEdits, host: EditorHost): boolean {
  // 고른 추가 뷰: 그 뷰 + 그 뷰를 부모로 하는 상세도 + 그 뷰에 놓은 치수
  const vid = sheetEdit.selectedView;
  if (vid && sh) {
    const gone = new Set([vid, ...host.views().filter((x) => x.kind === "detail" && x.parent === vid).map((x) => x.id)]);
    host.editViews((l) => l.filter((x) => !gone.has(x.id)), "뷰 지우기");
    if ((edits.dims ?? []).some((d) => gone.has(d.view))) host.edit((e) => (e.dims = (e.dims ?? []).filter((d) => !gone.has(d.view))), "뷰의 치수 지우기");
    sheetEdit.selectedView = null;
    host.changed();
    return true;
  }
  const id = sheetEdit.selected;
  if (!id || !sh) return false;
  const isManual = (edits.dims ?? []).some((d) => d.id === id);
  host.edit((e) => {
    if (isManual) e.dims = (e.dims ?? []).filter((d) => d.id !== id);
    else e.hide = [...new Set([...(e.hide ?? []), id])];
  }, isManual ? "치수 지우기" : "자동 치수 숨기기");
  sheetEdit.selected = null;
  host.changed();
  return true;
}

/** 치수 글자 고치는 작은 입력칸 */
function editText(svg: SVGSVGElement, d: DimDraw, value: string, label: string, done: (v: string) => void) {
  const m = svg.getScreenCTM();
  const host = svg.parentElement!;
  if (!m) return;
  const H = svg.viewBox.baseVal.height;
  const pt = svg.createSVGPoint();
  pt.x = d.box[0];
  pt.y = H - d.box[3];
  const q = pt.matrixTransform(m);
  const r = host.getBoundingClientRect();
  const inp = document.createElement("input");
  inp.className = "dim-edit";
  inp.value = value;
  inp.placeholder = label;
  inp.title = label;
  inp.style.left = `${q.x - r.left + host.scrollLeft}px`;
  inp.style.top = `${q.y - r.top + host.scrollTop - 30}px`;
  host.appendChild(inp);
  inp.focus();
  inp.select();
  let closed = false;
  const close = (ok: boolean) => {
    if (closed) return;
    closed = true;
    const v = inp.value;
    inp.remove();
    if (ok && v !== value) done(v);
  };
  inp.onkeydown = (e) => {
    if (e.key === "Enter") close(true);
    if (e.key === "Escape") close(false);
    e.stopPropagation();
  };
  inp.onblur = () => close(true);
}

function targets(sh: Sheet): Target {
  const out: Target = { pts: [], circles: [], lines: [] };
  for (const pr of sh.prims) {
    if (pr.layer === "FRAME" || pr.layer === "DIM") continue;
    if (pr.t === "line") {
      if (pr.layer === "CENTER") continue;
      out.lines.push({ a: pr.a, b: pr.b });
      out.pts.push({ p: pr.a, kind: "end" }, { p: pr.b, kind: "end" }, { p: [(pr.a[0] + pr.b[0]) / 2, (pr.a[1] + pr.b[1]) / 2], kind: "mid" });
    } else if (pr.t === "arc") {
      let sweep = pr.end - pr.start;
      while (sweep <= 0) sweep += 360;
      const full = sweep >= 359.9;
      out.circles.push({ c: pr.c, r: pr.r, full, start: pr.start, end: pr.start + sweep });
      out.pts.push({ p: pr.c, kind: "center" });
      if (!full) {
        const a0 = (pr.start * Math.PI) / 180;
        const a1 = (pr.end * Math.PI) / 180;
        out.pts.push({ p: [pr.c[0] + pr.r * Math.cos(a0), pr.c[1] + pr.r * Math.sin(a0)], kind: "end" }, { p: [pr.c[0] + pr.r * Math.cos(a1), pr.c[1] + pr.r * Math.sin(a1)], kind: "end" });
      }
    }
  }
  // 3D 투영은 원을 원호 여러 개로 나누므로, 같은 중심·반지름의 원호를 모아 한 바퀴면 원으로
  const merged: Target["circles"] = [];
  for (const c of out.circles) {
    const g = merged.find((m) => Math.hypot(m.c[0] - c.c[0], m.c[1] - c.c[1]) < 1e-3 && Math.abs(m.r - c.r) < 1e-3);
    if (!g) merged.push({ ...c });
    else if (!g.full) {
      const total = g.end - g.start + (c.end - c.start);
      if (total >= 359.5) g.full = true;
      else if (Math.abs((((c.start - g.end) % 360) + 360) % 360) < 0.5) g.end += c.end - c.start;
      else if (Math.abs((((g.start - c.end) % 360) + 360) % 360) < 0.5) g.start -= c.end - c.start;
    }
  }
  out.circles = merged;
  return out;
}

function inSweep(c: { c: Pt; start: number; end: number }, P: Pt): boolean {
  const a = (Math.atan2(P[1] - c.c[1], P[0] - c.c[0]) * 180) / Math.PI;
  const t = (((a - c.start) % 360) + 360) % 360;
  return t <= c.end - c.start + 1e-6;
}

function segDist(P: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((P[0] - a[0]) * dx + (P[1] - a[1]) * dy) / L2));
  return Math.hypot(P[0] - (a[0] + t * dx), P[1] - (a[1] + t * dy));
}

function intersect(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r: Pt = [b[0] - a[0], b[1] - a[1]];
  const q: Pt = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * q[1] - r[1] * q[0];
  if (Math.abs(den) < 1e-9 * (Math.hypot(...r) * Math.hypot(...q) || 1)) return null;
  const t = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}
