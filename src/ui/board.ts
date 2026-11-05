/**
 * 제도판: 정면도·평면도·우측면도를 실제 종이 도면처럼 한 화면에 배치한다 (3각법).
 *
 *   ┌───────────┐
 *   │  평면도    │   ╱ ← 45° 연결선 (평면도의 Y ↔ 우측면도의 Y)
 *   └───────────┘ ╱
 *   ┌───────────┐ ┌──────┐
 *   │  정면도    │ │우측면도│
 *   └───────────┘ └──────┘
 *
 * - 평면도는 정면도와 X가, 우측면도는 정면도와 Z가 항상 일직선으로 맞는다.
 * - 화면 좌표(px) ↔ 도면 좌표(mm, 위가 +) ↔ 각 뷰 좌표(뷰마다 원점이 다름, offset으로 연결)
 * - 각 뷰의 그리기·편집은 SketchPane이 맡고, 이 클래스는 배치·화면 이동·확대·입력 분배를 맡는다.
 */
import { boundsOf, isDegenerate, shapeBounds } from "../core/geometry2d";
import { VIEW_AXES, VIEW_IDS, VIEW_LABEL, type ViewId } from "../core/types";
import { store } from "../store";
import { palette, SketchPane } from "./sketch";
import { ui } from "./state";

type Rect = [number, number, number, number]; // x0, y0, x1, y1

const ceil10 = (n: number) => Math.ceil(n / 10) * 10;

export class DraftBoard {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly panes: Record<ViewId, SketchPane>;
  dpr = 1;
  spaceDown = false;

  /** 각 뷰 원점의 도면 좌표 */
  private off: Record<ViewId, [number, number]> = { front: [0, 0], top: [0, 80], side: [100, 0] };
  /** 각 뷰의 내용 범위 (뷰 좌표, 여백 포함) */
  private frames: Record<ViewId, Rect> = { front: [0, 0, 60, 40], top: [0, 0, 60, 40], side: [0, 0, 40, 40] };
  /** 뷰 영역을 나누는 선 (도면 좌표): x보다 오른쪽은 우측면도, y보다 위는 평면도 */
  private split = { x: 90, y: 70 };
  private laidOut = false;
  private pan: { sx: number; sy: number; cx: number; cy: number } | null = null;
  private lockPane: SketchPane | null = null;
  private hoverPane: SketchPane | null = null;
  private needsFit = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.panes = Object.fromEntries(VIEW_IDS.map((v) => [v, new SketchPane(this, v)])) as Record<ViewId, SketchPane>;

    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", (e) => this.up(e));
    canvas.addEventListener("pointerleave", () => {
      this.hoverPane?.leave();
      this.hoverPane = null;
      if (ui.cursor) {
        ui.cursor = null;
        ui.emit();
      }
    });
    canvas.addEventListener("dblclick", () => {
      const p = this.panes[ui.activeView];
      if (ui.tool === "poly" && p.polyDraft.length >= 3) p.finishPoly();
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    window.addEventListener("keydown", (e) => {
      const a = document.activeElement;
      const typing = !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
      if (e.code === "Space" && !typing) this.spaceDown = true;
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") this.spaceDown = false;
    });
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  // ---------------- 좌표 ----------------

  get w() {
    return this.canvas.clientWidth;
  }
  get h() {
    return this.canvas.clientHeight;
  }
  offset(v: ViewId): [number, number] {
    return this.off[v];
  }
  sheetToScreen(gx: number, gy: number): [number, number] {
    const { scale, x, y } = ui.camera;
    return [this.w / 2 + (gx - x) * scale, this.h / 2 - (gy - y) * scale];
  }
  screenToSheet(sx: number, sy: number): [number, number] {
    const { scale, x, y } = ui.camera;
    return [(sx - this.w / 2) / scale + x, -(sy - this.h / 2) / scale + y];
  }
  private local(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** 도면 좌표가 속한 뷰 (오른쪽 위 빈 칸은 null) */
  regionAt(gx: number, gy: number): ViewId | null {
    if (gx <= this.split.x) return gy > this.split.y ? "top" : "front";
    return gy <= this.split.y ? "side" : null;
  }

  /** 뷰 영역의 화면 사각형 (캔버스 밖은 잘라냄) */
  regionScreenRect(v: ViewId): Rect {
    const [sx, sy] = this.sheetToScreen(this.split.x, this.split.y);
    const W = this.w;
    const H = this.h;
    const clamp = (r: Rect): Rect => [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(W, r[2]), Math.min(H, r[3])];
    if (v === "front") return clamp([0, sy, sx, H]);
    if (v === "top") return clamp([0, 0, sx, sy]);
    return clamp([sx, sy, W, H]);
  }

  // ---------------- 배치 ----------------

  /** 뷰마다 내용(도형 + 3D 결과)의 범위를 재서 겹치지 않게 배치. force가 아니면 간격은 넓어지기만 한다 */
  layout(force = false) {
    const local = (v: ViewId): Rect => {
      const boxes: Rect[] = store.project.views[v].filter((s) => !isDegenerate(s)).map((s) => shapeBounds(s) as Rect);
      const rb = ui.result?.[v]?.bounds;
      if (rb) boxes.push([rb[0][0], rb[0][1], rb[1][0], rb[1][1]]);
      if (!boxes.length) return v === "side" ? [0, 0, 40, 40] : [0, 0, 60, 40];
      boxes.push([0, 0, 0, 0]); // 원점도 보이게
      const b: Rect = [
        Math.min(...boxes.map((r) => r[0])),
        Math.min(...boxes.map((r) => r[1])),
        Math.max(...boxes.map((r) => r[2])),
        Math.max(...boxes.map((r) => r[3])),
      ];
      const m = Math.max(8, 0.12 * Math.max(b[2] - b[0], b[3] - b[1]));
      return [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
    };
    const F = local("front");
    const T = local("top");
    const S = local("side");
    this.frames = { front: F, top: T, side: S };
    const size = Math.max(F[2] - F[0], F[3] - F[1], T[2] - T[0], T[3] - T[1], S[2] - S[0], S[3] - S[1]);
    const gap = Math.max(16, Math.round(size * 0.12));
    const right = Math.max(F[2], T[2]); // 정면도·평면도의 오른쪽 끝 (X)
    const topEdge = Math.max(F[3], S[3]); // 정면도·우측면도의 위쪽 끝 (Z)
    const needTop = ceil10(topEdge + gap - T[1]);
    const needSide = ceil10(right + gap - S[0]);
    const grow = !force && this.laidOut;
    this.off = {
      front: [0, 0],
      top: [0, grow ? Math.max(this.off.top[1], needTop) : needTop],
      side: [grow ? Math.max(this.off.side[0], needSide) : needSide, 0],
    };
    this.split = { x: (right + this.off.side[0] + S[0]) / 2, y: (topEdge + this.off.top[1] + T[1]) / 2 };
    this.laidOut = true;
  }

  /** 뷰 틀의 화면 사각형 [왼, 위, 오른, 아래] */
  frameScreenRect(v: ViewId): Rect {
    const f = this.frameSheet(v);
    const [x0, y1] = this.sheetToScreen(f[0], f[1]);
    const [x1, y0] = this.sheetToScreen(f[2], f[3]);
    return [x0, y0, x1, y1];
  }

  /** 도면 좌표로 본 뷰의 틀 */
  private frameSheet(v: ViewId): Rect {
    const f = this.frames[v];
    const [ox, oy] = this.off[v];
    return [f[0] + ox, f[1] + oy, f[2] + ox, f[3] + oy];
  }

  private fitRect(r: Rect) {
    const W = this.w;
    const H = this.h;
    if (!W || !H) {
      this.needsFit = true;
      return;
    }
    ui.camera.scale = Math.min(Math.max(Math.min((W * 0.9) / (r[2] - r[0]), (H * 0.86) / (r[3] - r[1])), 0.05), 400);
    ui.camera.x = (r[0] + r[2]) / 2;
    ui.camera.y = (r[1] + r[3]) / 2 + 4 / ui.camera.scale;
    this.needsFit = false;
  }

  /** 세 뷰가 모두 보이게 */
  fitAll() {
    this.layout(true);
    const rs = VIEW_IDS.map((v) => this.frameSheet(v));
    this.fitRect([Math.min(...rs.map((r) => r[0])), Math.min(...rs.map((r) => r[1])), Math.max(...rs.map((r) => r[2])), Math.max(...rs.map((r) => r[3]))]);
    ui.emit();
  }

  /** 한 뷰만 크게 */
  focus(v: ViewId) {
    this.layout();
    this.fitRect(this.frameSheet(v));
    ui.activeView = v;
    ui.emit();
  }

  // ---------------- 입력 ----------------

  /** 그리는 중인 뷰 (다각형 점 찍기, 클릭-클릭 사각형, 측정 중) */
  private pendingPane(): SketchPane | null {
    return VIEW_IDS.map((v) => this.panes[v]).find((p) => p.pending) ?? null;
  }

  private paneAt(x: number, y: number): SketchPane | null {
    const v = this.regionAt(...this.screenToSheet(x, y));
    return v ? this.panes[v] : null;
  }

  startPan(x: number, y: number) {
    this.pan = { sx: x, sy: y, cx: ui.camera.x, cy: ui.camera.y };
  }

  private down(e: PointerEvent) {
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.focus();
    const [x, y] = this.local(e);
    if (e.button === 1 || e.button === 2 || this.spaceDown) {
      this.startPan(x, y);
      return;
    }
    if (e.button !== 0) return;
    const pane = this.pendingPane() ?? this.paneAt(x, y);
    if (!pane) {
      this.startPan(x, y);
      return;
    }
    this.lockPane = pane;
    pane.down(e);
  }

  private move(e: PointerEvent) {
    const [x, y] = this.local(e);
    if (this.pan) {
      const { scale } = ui.camera;
      ui.camera.x = this.pan.cx - (x - this.pan.sx) / scale;
      ui.camera.y = this.pan.cy + (y - this.pan.sy) / scale;
      ui.emit();
      return;
    }
    const pane = this.lockPane ?? this.pendingPane() ?? this.paneAt(x, y);
    if (this.hoverPane && this.hoverPane !== pane) this.hoverPane.leave();
    this.hoverPane = pane;
    if (pane) pane.move(e);
    else if (ui.cursor) {
      ui.cursor = null;
      ui.emit();
    } else this.render();
  }

  private up(e: PointerEvent) {
    if (this.pan) {
      this.pan = null;
      this.lockPane?.up(e);
      this.lockPane = null;
      return;
    }
    this.lockPane?.up(e);
    this.lockPane = null;
    ui.emit();
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const [x, y] = this.local(e);
    // 트랙패드 두 손가락 스크롤(가로 이동이 섞임) → 화면 이동, 그 외 → 확대/축소
    const isPan = !e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaX) > 0.5;
    if (isPan) {
      ui.camera.x += e.deltaX / ui.camera.scale;
      ui.camera.y -= e.deltaY / ui.camera.scale;
      ui.emit();
      return;
    }
    const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    const before = this.screenToSheet(x, y);
    ui.camera.scale = Math.min(Math.max(ui.camera.scale * k, 0.05), 400);
    const after = this.screenToSheet(x, y);
    ui.camera.x += before[0] - after[0];
    ui.camera.y += before[1] - after[1];
    ui.emit();
  }

  // ---------------- 그리기 ----------------

  private resize() {
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    if (this.needsFit && this.w && this.h) this.fitAll();
    else this.render();
  }

  render() {
    const c = this.ctx;
    const col = palette();
    const W = this.w;
    const H = this.h;
    if (!W || !H) return;
    // 끌거나 그리는 동안에는 배치를 고정 (뷰가 움직이면 커서와 어긋남)
    if (!this.lockPane && !this.pendingPane()) this.layout();
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // 종이 한 장: 바탕과 격자는 세 뷰와 오른쪽 위 칸까지 끊김 없이 이어진다
    c.fillStyle = col.bg;
    c.fillRect(0, 0, W, H);
    this.drawGrid();

    for (const v of VIEW_IDS) {
      const r = this.regionScreenRect(v);
      if (r[2] <= r[0] || r[3] <= r[1]) continue;
      c.save();
      c.beginPath();
      c.rect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
      c.clip();
      this.panes[v].renderContent();
      c.restore();
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    this.drawCorner();
    this.drawFrames();
  }

  /** 뷰 틀과 이름 */
  private drawFrames() {
    const c = this.ctx;
    const col = palette();
    for (const v of VIEW_IDS) {
      const f = this.frameSheet(v);
      const [x0, y1] = this.sheetToScreen(f[0], f[1]);
      const [x1, y0] = this.sheetToScreen(f[2], f[3]);
      const active = ui.activeView === v;
      c.strokeStyle = active ? col.accent : col.frame;
      c.lineWidth = active ? 1.5 : 1;
      c.setLineDash(active ? [] : [6, 4]);
      c.beginPath();
      c.roundRect(x0, y0, x1 - x0, y1 - y0, 6);
      c.stroke();
      c.setLineDash([]);
      const [ua, va] = VIEW_AXES[v];
      const label = `${VIEW_LABEL[v]}  ${ua}–${va}`;
      c.font = `${active ? 700 : 600} 12px system-ui, sans-serif`;
      c.textAlign = "left";
      c.textBaseline = "bottom";
      const tw = c.measureText(label).width + 14;
      c.fillStyle = active ? col.accent : col.frameLabelBg;
      c.beginPath();
      c.roundRect(x0, y0 - 22, tw, 20, 5);
      c.fill();
      c.fillStyle = active ? "#fff" : col.text;
      c.fillText(label, x0 + 7, y0 - 6.5);
    }
  }

  /** 도면 좌표 기준 격자 (뷰 원점이 10mm 단위에 놓이므로 각 뷰의 격자와도 맞는다) */
  private drawGrid() {
    const c = this.ctx;
    const col = palette();
    const W = this.w;
    const H = this.h;
    const steps = [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    const step = steps.find((s) => s >= (ui.grid || 1) && s * ui.camera.scale >= 8) ?? 5000;
    const major = steps.find((s) => s >= step * 5) ?? step * 5;
    const [x0, y1] = this.screenToSheet(0, 0);
    const [x1, y0] = this.screenToSheet(W, H);
    c.lineWidth = 1;
    for (const [st, color] of [
      [step, col.gridMinor],
      [major, col.gridMajor],
    ] as const) {
      c.strokeStyle = color;
      c.beginPath();
      for (let gx = Math.floor(x0 / st) * st; gx <= x1; gx += st) {
        const x = Math.round(this.sheetToScreen(gx, 0)[0]) + 0.5;
        c.moveTo(x, 0);
        c.lineTo(x, H);
      }
      for (let gy = Math.floor(y0 / st) * st; gy <= y1; gy += st) {
        const y = Math.round(this.sheetToScreen(0, gy)[1]) + 0.5;
        c.moveTo(0, y);
        c.lineTo(W, y);
      }
      c.stroke();
    }
  }

  /** 오른쪽 위 칸: 평면도 ↔ 우측면도의 깊이(Y)를 잇는 45° 선 (제도에서 쓰는 보조선) */
  private drawCorner() {
    const c = this.ctx;
    const col = palette();
    const [sx, sy] = this.sheetToScreen(this.split.x, this.split.y);
    if (sx >= this.w || sy <= 0) return;
    c.save();
    c.beginPath();
    c.rect(sx, 0, this.w - sx, sy);
    c.clip();
    const ot = this.off.top[1];
    const os = this.off.side[0];
    // 45° 선: 평면도의 Y(위로 증가) = 우측면도의 Y(오른쪽으로 증가)
    const seg = (y: number): [[number, number], [number, number], [number, number]] => [
      this.sheetToScreen(this.split.x, y + ot),
      this.sheetToScreen(y + os, y + ot),
      this.sheetToScreen(y + os, this.split.y),
    ];
    const big = 1e5;
    const a = this.sheetToScreen(this.split.x, this.split.x - os + ot);
    const b = this.sheetToScreen(this.split.x + big, this.split.x + big - os + ot);
    // 평면도·우측면도를 쓸 때만 보이는 옅은 선
    const used = (["top", "side"] as ViewId[]).some((v) => store.project.views[v].length > 0) || !!ui.result;
    if (used) {
      c.strokeStyle = col.frame;
      c.globalAlpha = 0.45;
      c.lineWidth = 1;
      c.setLineDash([8, 4, 2, 4]);
      c.beginPath();
      c.moveTo(a[0], a[1]);
      c.lineTo(b[0], b[1]);
      c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
      // 선 옆에 짧은 설명
      const t = 0.18;
      const lx = sx + (this.w - sx) * t;
      const ly = a[1] + (lx - a[0]) * ((b[1] - a[1]) / (b[0] - a[0]));
      if (ly > 14 && ly < sy - 6) {
        c.fillStyle = col.text;
        c.globalAlpha = 0.75;
        c.font = "11px system-ui, sans-serif";
        c.textAlign = "left";
        c.textBaseline = "bottom";
        c.fillText("45° 연결선: 평면도 ↔ 우측면도 깊이(Y)", lx + 8, ly - 4);
        c.globalAlpha = 1;
      }
    }
    // 지금 커서의 Y (평면도·우측면도에서만)
    const cy = ui.cursor?.[1];
    if (cy != null && (ui.activeView === "top" || ui.activeView === "side")) {
      const [p, q, r] = seg(cy);
      c.strokeStyle = col.accent;
      c.globalAlpha = 0.5;
      c.setLineDash([]);
      c.beginPath();
      c.moveTo(...p);
      c.lineTo(...q);
      c.lineTo(...r);
      c.stroke();
      c.globalAlpha = 1;
    }
    c.setLineDash([]);
    c.restore();

    // 우측면도에 그어지는 평면도 깊이(Y) 보조선을 45° 선을 돌아 평면도의 그 모서리까지 잇는다
    const tb = boundsOf(store.project.views.top);
    if (tb && store.project.mode === "auto") {
      c.strokeStyle = col.guide;
      c.globalAlpha = 0.7;
      c.lineWidth = 1;
      c.setLineDash([4, 4]);
      for (const y of [tb[1], tb[3]]) {
        const start = this.sheetToScreen(tb[2], y + ot);
        const [, q, r] = seg(y);
        c.beginPath();
        c.moveTo(...start);
        c.lineTo(...q);
        c.lineTo(...r);
        c.stroke();
      }
      c.setLineDash([]);
      c.globalAlpha = 1;
    }
  }
}
