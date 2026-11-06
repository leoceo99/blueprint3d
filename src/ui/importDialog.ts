/**
 * 도면 이미지 가져오기 창.
 * 사진·스캔·PDF → (사진이면 종이 펴기) → 뷰·구멍 인식 → 사용자가 뷰 이름·척도·구멍을 확인 → 프로젝트로.
 */
import type { Analysis, DetectedView } from "../core/vision/detect";
import type { PipelineOptions } from "../core/vision/pipeline";
import type { P2 } from "../core/vision/raster";
import { buildProject, defaultChoice, type ImportChoice } from "../core/vision/toProject";
import type { Project, Underlay, ViewId } from "../core/types";
import { VIEW_LABEL } from "../core/types";
import { maskToDataUrl } from "../underlay";
import type { VisionRequest, VisionResponse } from "../visionWorker";

type Result = Extract<VisionResponse, { ok: true }>;

const PAPER_MM: Record<string, number> = { A4: 297, A3: 420, A2: 594, A1: 841, A0: 1189 };
const SCALES = ["5:1", "2:1", "1:1", "1:2", "1:5", "1:10", "1:20"];
const ROLE_COLOR: Record<ViewId, string> = { front: "#2563eb", top: "#16a34a", side: "#d97706" };
const MAX_INPUT = 3600;

export interface ImportOutcome {
  project: Project;
  /** 밑그림 이미지 (선만, 투명 바탕 PNG) */
  underlay?: { dataUrl: string; meta: Underlay };
}

let worker: Worker | null = null;
let seq = 0;
function analyze(req: Omit<VisionRequest, "id">): Promise<Result> {
  worker ??= new Worker(new URL("../visionWorker.ts", import.meta.url), { type: "module" });
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const w = worker!;
    const handler = (ev: MessageEvent<VisionResponse>) => {
      if (ev.data.id !== id) return;
      w.removeEventListener("message", handler);
      if (ev.data.ok) resolve(ev.data);
      else reject(new Error(ev.data.error));
    };
    w.addEventListener("message", handler);
    w.postMessage({ ...req, id }, [req.rgba.buffer]);
  });
}

/** 파일 → 캔버스 (이미지 또는 PDF 한 쪽) */
async function fileToCanvas(file: File, page = 1): Promise<{ canvas: HTMLCanvasElement; pages: number }> {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (isPdf) {
    const pdfjs = await import("pdfjs-dist");
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const p = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
    const vp0 = p.getViewport({ scale: 1 });
    const vp = p.getViewport({ scale: 3000 / Math.max(vp0.width, vp0.height) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await p.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
    return { canvas, pages: doc.numPages };
  }
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX_INPUT / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return { canvas, pages: 1 };
}

/** 원본을 시계 방향으로 rot×90° 돌린 캔버스 */
function rotated(src: HTMLCanvasElement, rot: number): HTMLCanvasElement {
  rot = ((rot % 4) + 4) % 4;
  if (!rot) return src;
  const c = document.createElement("canvas");
  c.width = rot % 2 ? src.height : src.width;
  c.height = rot % 2 ? src.width : src.height;
  const ctx = c.getContext("2d")!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rot * Math.PI) / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, cls?: string, kids: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}

export class ImportDialog {
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private panel: HTMLElement;
  private msg: HTMLElement;
  private file: File | null = null;
  private page = 1;
  private pages = 1;
  private src: HTMLCanvasElement | null = null;
  private rot = 0;
  private quad: P2[] | null | "auto" = "auto";
  private res: Result | null = null;
  private proc: HTMLCanvasElement | null = null;
  private choice: ImportChoice | null = null;
  private scaleMode: "paper" | "length" = "paper";
  private paper = "A4";
  private scale = "1:1";
  private measure: { a: P2 | null; b: P2 | null; mm: number } = { a: null, b: null, mm: 0 };
  private mode: "view" | "corners" | "measure" = "view";
  private handles: P2[] = [];
  private drag: { kind: "pan" | "handle"; i: number; sx: number; sy: number; tx: number; ty: number } | null = null;
  private cam = { k: 1, tx: 0, ty: 0 };
  private underlayOn = true;
  private busy = false;
  private hover: P2 | null = null;

  constructor(private onDone: (out: ImportOutcome) => void) {
    this.canvas = h("canvas", {}, "imp-canvas");
    this.ctx = this.canvas.getContext("2d")!;
    this.msg = h("div", {}, "imp-msg");
    this.panel = h("aside", {}, "imp-panel");
    const close = h("button", { textContent: "닫기", title: "Esc" });
    close.onclick = () => this.close();
    const pick = h("button", { textContent: "다른 파일…" });
    pick.onclick = () => this.pickFile();
    this.root = h("div", { hidden: true }, "import-dlg", [
      h("div", {}, "imp-head", [h("b", { textContent: "도면 이미지 가져오기" }), h("span", { id: "impFile" }, "muted"), h("div", {}, "spacer"), pick, close]),
      h("div", {}, "imp-body", [h("div", {}, "imp-stage", [this.canvas, this.msg]), this.panel]),
    ]);
    document.body.appendChild(this.root);
    this.bindCanvas();
    window.addEventListener("resize", () => !this.root.hidden && this.draw());
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (this.mode !== "view") this.setMode("view");
        else this.close();
      }
    });
  }

  get isOpen() {
    return !this.root.hidden;
  }

  pickFile() {
    const input = h("input", { type: "file", accept: "image/*,.pdf,application/pdf" });
    input.onchange = () => input.files?.[0] && this.open(input.files[0]);
    input.click();
  }

  async open(file: File) {
    this.root.hidden = false;
    this.root.tabIndex = -1;
    this.root.focus();
    this.file = file;
    this.page = 1;
    this.rot = 0;
    this.quad = "auto";
    this.res = null;
    this.choice = null;
    this.mode = "view";
    this.measure = { a: null, b: null, mm: 0 };
    (this.root.querySelector("#impFile") as HTMLElement).textContent = file.name;
    await this.load();
  }

  close() {
    this.root.hidden = true;
  }

  private async load() {
    if (!this.file) return;
    this.setBusy("이미지를 읽는 중…");
    try {
      const { canvas, pages } = await fileToCanvas(this.file, this.page);
      this.src = canvas;
      this.pages = pages;
    } catch (e) {
      this.setBusy(`이미지를 읽을 수 없습니다: ${(e as Error).message}`, false);
      return;
    }
    await this.run();
  }

  private async run() {
    if (!this.src) return;
    this.setBusy("도면을 읽는 중… (선·뷰·구멍 찾기)");
    const ctx = this.src.getContext("2d")!;
    const data = ctx.getImageData(0, 0, this.src.width, this.src.height).data;
    const opts: PipelineOptions = { rotate90: this.rot, quad: this.quad === "auto" ? "auto" : this.quad };
    try {
      const res = await analyze({ rgba: new Uint8ClampedArray(data), w: this.src.width, h: this.src.height, opts });
      this.res = res;
      this.proc = grayCanvas(res.gray, res.w, res.h);
      this.choice = defaultChoice(res.analysis, 1, this.file?.name.replace(/\.[^.]+$/, "") || "가져온 도면");
      // 척도: 종이를 폈거나 이미지가 A 용지 비율이면 용지 기준, 아니면 아는 길이로
      const ratio = Math.max(res.w, res.h) / Math.min(res.w, res.h);
      this.scaleMode = res.quad || Math.abs(ratio - Math.SQRT2) < 0.05 ? "paper" : "length";
      this.applyScale();
      this.setBusy("", false);
      this.fit();
      this.renderPanel();
      this.draw();
    } catch (e) {
      this.setBusy(`인식하지 못했습니다: ${(e as Error).message}`, false);
    }
  }

  private setBusy(text: string, busy = true) {
    this.busy = busy;
    this.msg.textContent = text;
    this.msg.hidden = !text;
    if (busy) this.renderPanel();
  }

  /** mm/px 다시 계산 */
  private applyScale() {
    if (!this.res || !this.choice) return;
    const { w, h } = this.res;
    if (this.scaleMode === "paper") {
      const [a, b] = this.scale.split(":").map(Number);
      this.choice.mmPerPx = (PAPER_MM[this.paper] / Math.max(w, h)) * (b / a);
    } else if (this.measure.a && this.measure.b && this.measure.mm > 0) {
      const d = Math.hypot(this.measure.b[0] - this.measure.a[0], this.measure.b[1] - this.measure.a[1]);
      this.choice.mmPerPx = this.measure.mm / d;
    } else {
      // 아직 재지 않았으면 A4 1:1로 가정 (크기 표시용)
      this.choice.mmPerPx = PAPER_MM.A4 / Math.max(w, h);
    }
  }

  // ---------------- 오른쪽 패널 ----------------

  private renderPanel() {
    const p = this.panel;
    p.innerHTML = "";
    if (this.busy || !this.res || !this.choice) {
      p.append(h("div", { textContent: this.busy ? "잠시만요…" : "이미지를 고르세요." }, "imp-sec muted"));
      return;
    }
    const an = this.res.analysis;
    const ch = this.choice;

    // 1) 이미지
    const rot = h("button", { textContent: "↻ 90° 돌리기", title: "도면이 옆으로 누워 있으면" });
    rot.onclick = () => {
      this.rot = (this.rot + 1) % 4;
      this.quad = "auto";
      this.run();
    };
    const corners = h("button", { textContent: this.mode === "corners" ? "모서리 맞추는 중…" : "종이 모서리 맞추기", title: "사진 속 종이의 네 모서리를 직접 맞춥니다" });
    corners.onclick = () => this.setMode(this.mode === "corners" ? "view" : "corners");
    const info: string[] = [];
    if (this.res.quad) info.push("사진 속 종이를 찾아 반듯하게 폈어요");
    if (Math.abs(this.res.angle) > 0.05) info.push(`기울기 ${this.res.angle.toFixed(1)}° 바로잡음`);
    info.push(`선 굵기 ${this.res.analysis.stroke.thin ? "두 가지(가는 선은 치수·중심선으로 보고 뺐어요)" : "한 가지"}`);
    const pageSel = this.pages > 1 ? this.pageSelect() : null;
    p.append(
      section("1. 이미지", [h("div", {}, "imp-row", [rot, corners]), ...(pageSel ? [pageSel] : []), h("p", { textContent: info.join(" · ") }, "muted small")]),
    );

    // 2) 뷰
    const real = an.views.filter((v) => !v.frame || ch.roles[v.id]);
    const rows = real.map((v) => {
      const sel = h("select");
      for (const [val, label] of [["", "쓰지 않음"], ["front", "정면도"], ["top", "평면도"], ["side", "우측면도"]] as const)
        sel.append(h("option", { value: val, textContent: label, selected: (ch.roles[v.id] ?? "") === val }));
      sel.onchange = () => {
        const role = (sel.value || null) as ViewId | null;
        if (role) for (const o of an.views) if (ch.roles[o.id] === role) ch.roles[o.id] = null;
        ch.roles[v.id] = role;
        if (!Object.values(ch.roles).includes("top")) ch.revolve = false;
        this.renderPanel();
        this.draw();
      };
      const [wmm, hmm] = this.sizeMM(v);
      const role = ch.roles[v.id];
      const chip = h("span", {}, "imp-chip");
      chip.style.background = role ? ROLE_COLOR[role] : "#9ca3af";
      const holes = v.holes.filter((x) => ch.holes[x.id]).length;
      return h("div", {}, "imp-view", [chip, sel, h("span", { textContent: `${fmt(wmm)} × ${fmt(hmm)} mm${holes ? ` · 구멍 ${holes}` : ""}` }, "muted small")]);
    });
    const frames = an.views.filter((v) => v.frame && !ch.roles[v.id]).length;
    p.append(
      section("2. 뷰", [
        ...(rows.length ? rows : [h("p", { textContent: "뷰를 찾지 못했어요. 외형선이 끊기지 않았는지, 이미지가 흐리지 않은지 확인하세요." }, "warn small")]),
        h("p", { textContent: `3각법: 평면도는 정면도 위, 우측면도는 정면도 오른쪽.${frames ? " 도면 테두리는 뺐어요." : ""}` }, "muted small"),
      ]),
    );

    // 3) 크기
    const modePaper = radio("scale", "용지 기준", this.scaleMode === "paper", () => {
      this.scaleMode = "paper";
      this.setMode("view");
      this.applyScale();
      this.renderPanel();
    });
    const modeLen = radio("scale", "아는 길이로", this.scaleMode === "length", () => {
      this.scaleMode = "length";
      this.applyScale();
      this.renderPanel();
      if (!this.measure.a) this.setMode("measure");
    });
    const paperSel = h("select");
    for (const k of Object.keys(PAPER_MM)) paperSel.append(h("option", { value: k, textContent: k, selected: k === this.paper }));
    paperSel.onchange = () => {
      this.paper = paperSel.value;
      this.applyScale();
      this.renderPanel();
    };
    const scaleSel = h("select");
    for (const k of SCALES) scaleSel.append(h("option", { value: k, textContent: k, selected: k === this.scale }));
    scaleSel.onchange = () => {
      this.scale = scaleSel.value;
      this.applyScale();
      this.renderPanel();
    };
    const sizeBody: Node[] = [h("div", {}, "imp-row", [modePaper, modeLen])];
    if (this.scaleMode === "paper") {
      sizeBody.push(
        h("div", {}, "imp-row", [h("label", {}, "", ["용지 ", paperSel]), h("label", {}, "", ["척도 ", scaleSel])]),
        h("p", { textContent: "이미지가 용지 한 장 전체일 때 맞습니다 (스캔, 종이를 편 사진, PDF). 표제란의 척도를 고르세요." }, "muted small"),
      );
    } else {
      const btn = h("button", { textContent: this.mode === "measure" ? "두 점을 찍으세요…" : this.measure.a ? "다시 재기" : "두 점 찍기" });
      btn.onclick = () => {
        this.measure = { a: null, b: null, mm: this.measure.mm };
        this.setMode("measure");
      };
      const mm = h("input", { type: "number", min: "0", step: "any", value: this.measure.mm ? String(this.measure.mm) : "", placeholder: "길이 mm" });
      mm.onchange = () => {
        this.measure.mm = parseFloat(mm.value) || 0;
        this.applyScale();
        this.renderPanel();
        this.draw();
      };
      sizeBody.push(
        h("div", {}, "imp-row", [btn, h("label", {}, "", [mm, " mm"])]),
        h("p", { textContent: this.measure.a && this.measure.b ? "그 두 점 사이의 실제 길이를 넣으세요 (예: 전체 가로 치수)." : "치수가 적힌 두 점(예: 정면도 왼쪽과 오른쪽 모서리)을 찍고 그 길이를 넣으세요." }, "muted small"),
      );
    }
    sizeBody.push(h("p", { textContent: `1 px = ${ch.mmPerPx.toFixed(4)} mm` }, "muted small"));
    p.append(section("3. 크기", sizeBody));

    // 4) 구멍과 옵션
    const used = an.views.filter((v) => ch.roles[v.id]);
    const total = used.reduce((a, v) => a + v.holes.length, 0);
    const on = used.reduce((a, v) => a + v.holes.filter((x) => ch.holes[x.id]).length, 0);
    const opts: Node[] = [h("p", { textContent: `구멍 ${on}/${total}개 사용 — 그림에서 구멍을 누르면 켜고 끌 수 있어요 (빨강 = 사용, 회색 점선 = 안 씀).` }, "muted small")];
    const rev = h("input", { type: "checkbox", checked: ch.revolve });
    rev.onchange = () => {
      ch.revolve = rev.checked;
      this.draw();
    };
    opts.push(h("label", { title: "평면도가 원이고 정면도·우측면도가 같으면 회전체로 만드는 것이 정확합니다" }, "imp-check", [rev, " 회전체로 만들기 (원통형 부품)"]));
    const snap = h("select");
    for (const g of [0.1, 0.5, 1]) snap.append(h("option", { value: String(g), textContent: `${g} mm`, selected: ch.snap === g }));
    snap.onchange = () => (ch.snap = parseFloat(snap.value));
    opts.push(h("label", {}, "imp-row", ["좌표 맞춤 ", snap]));
    if (used.length === 1) {
      const t = h("input", { type: "number", min: "0.1", step: "any", value: String(ch.thickness) });
      t.onchange = () => (ch.thickness = Math.max(0.1, parseFloat(t.value) || ch.thickness));
      opts.push(h("label", {}, "imp-row", ["두께 ", t, " mm (뷰가 하나라서)"]));
    }
    const ul = h("input", { type: "checkbox", checked: this.underlayOn });
    ul.onchange = () => (this.underlayOn = ul.checked);
    opts.push(h("label", {}, "imp-check", [ul, " 이 도면을 제도판에 밑그림으로 깔기"]));
    p.append(section("4. 구멍과 설정", opts));

    const go = h("button", { textContent: "가져와서 3D 만들기" }, "primary imp-go");
    go.disabled = !used.length || (this.scaleMode === "length" && !(this.measure.a && this.measure.b && this.measure.mm > 0));
    go.title = go.disabled ? "뷰를 하나 이상 고르고 크기를 정하세요" : "지금 도면을 바꿉니다 (Ctrl+Z로 되돌릴 수 있어요)";
    go.onclick = () => this.finish();
    p.append(h("div", {}, "imp-foot", [go, h("p", { textContent: "가져온 뒤에도 치수·구멍은 속성 패널에서 고칠 수 있어요." }, "muted small")]));
  }

  private pageSelect(): HTMLElement {
    const sel = h("select");
    for (let i = 1; i <= this.pages; i++) sel.append(h("option", { value: String(i), textContent: `${i}쪽`, selected: i === this.page }));
    sel.onchange = () => {
      this.page = parseInt(sel.value, 10);
      this.quad = "auto";
      this.load();
    };
    return h("label", {}, "imp-row", ["PDF ", sel, ` / ${this.pages}쪽`]);
  }

  private sizeMM(v: DetectedView): [number, number] {
    const s = this.choice!.mmPerPx;
    return [(v.box[2] - v.box[0]) * s, (v.box[3] - v.box[1]) * s];
  }

  private finish() {
    if (!this.res || !this.choice) return;
    const { project, maps } = buildProject(this.res.analysis, this.choice);
    let underlay: ImportOutcome["underlay"];
    if (this.underlayOn) {
      const key = `u${Date.now().toString(36)}`;
      const meta: Underlay = { key, w: this.res.w, h: this.res.h, mmPerPx: this.choice.mmPerPx, views: maps };
      underlay = { dataUrl: maskToDataUrl(this.res.ink, this.res.w, this.res.h), meta };
      project.underlay = meta;
    }
    this.close();
    this.onDone({ project, underlay });
  }

  private setMode(m: "view" | "corners" | "measure") {
    this.mode = m;
    if (m === "corners" && this.src) {
      const r = rotated(this.src, this.rot);
      const q = this.res?.quad;
      this.handles = q
        ? q.map((p) => [...p] as P2)
        : [
            [r.width * 0.05, r.height * 0.05],
            [r.width * 0.95, r.height * 0.05],
            [r.width * 0.95, r.height * 0.95],
            [r.width * 0.05, r.height * 0.95],
          ];
    }
    this.fit();
    this.renderPanel();
    if (m === "corners") this.renderCornerBar();
    this.draw();
  }

  private renderCornerBar() {
    const apply = h("button", { textContent: "이 모서리로 펴기" }, "primary");
    apply.onclick = () => {
      this.quad = this.handles.map((p) => [...p] as P2);
      this.mode = "view";
      this.run();
    };
    const none = h("button", { textContent: "펴지 않기 (스캔·캡처)" });
    none.onclick = () => {
      this.quad = null;
      this.mode = "view";
      this.run();
    };
    const auto = h("button", { textContent: "자동으로" });
    auto.onclick = () => {
      this.quad = "auto";
      this.mode = "view";
      this.run();
    };
    this.panel.prepend(section("종이 모서리", [h("p", { textContent: "파란 점 네 개를 종이 모서리로 끌어 놓으세요." }, "muted small"), h("div", {}, "imp-row", [apply, none, auto])]));
  }

  // ---------------- 캔버스 ----------------

  private imageSize(): [number, number] {
    if (this.mode === "corners" && this.src) return this.rot % 2 ? [this.src.height, this.src.width] : [this.src.width, this.src.height];
    return this.res ? [this.res.w, this.res.h] : [1, 1];
  }

  private fit() {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    const [w, hh] = this.imageSize();
    const k = Math.min(r.width / w, r.height / hh) * 0.96;
    this.cam = { k, tx: (r.width - w * k) / 2, ty: (r.height - hh * k) / 2 };
  }

  private toImg(sx: number, sy: number): P2 {
    return [(sx - this.cam.tx) / this.cam.k, (sy - this.cam.ty) / this.cam.k];
  }

  private bindCanvas() {
    const c = this.canvas;
    const local = (e: MouseEvent): [number, number] => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [x, y] = local(e);
      const f = Math.exp(-e.deltaY * 0.0015);
      const k = Math.min(Math.max(this.cam.k * f, 0.02), 20);
      this.cam.tx = x - ((x - this.cam.tx) * k) / this.cam.k;
      this.cam.ty = y - ((y - this.cam.ty) * k) / this.cam.k;
      this.cam.k = k;
      this.draw();
    });
    c.addEventListener("pointerdown", (e) => {
      const [x, y] = local(e);
      c.setPointerCapture(e.pointerId);
      if (this.mode === "corners") {
        const i = this.handles.findIndex((p) => Math.hypot(p[0] * this.cam.k + this.cam.tx - x, p[1] * this.cam.k + this.cam.ty - y) < 14);
        if (i >= 0) {
          this.drag = { kind: "handle", i, sx: x, sy: y, tx: 0, ty: 0 };
          return;
        }
      }
      this.drag = { kind: "pan", i: -1, sx: x, sy: y, tx: this.cam.tx, ty: this.cam.ty };
    });
    c.addEventListener("pointermove", (e) => {
      const [x, y] = local(e);
      this.hover = this.toImg(x, y);
      if (!this.drag) {
        if (this.mode === "measure") this.draw();
        return;
      }
      if (this.drag.kind === "handle") this.handles[this.drag.i] = this.toImg(x, y);
      else {
        this.cam.tx = this.drag.tx + x - this.drag.sx;
        this.cam.ty = this.drag.ty + y - this.drag.sy;
      }
      this.draw();
    });
    c.addEventListener("pointerup", (e) => {
      const [x, y] = local(e);
      const d = this.drag;
      this.drag = null;
      // 거의 움직이지 않았으면 클릭
      if (d && d.kind === "pan" && Math.hypot(x - d.sx, y - d.sy) < 4) this.click(this.toImg(x, y));
    });
  }

  private click(p: P2) {
    if (!this.res || !this.choice) return;
    if (this.mode === "measure") {
      const q = this.snapPoint(p);
      if (!this.measure.a || this.measure.b) this.measure = { a: q, b: null, mm: this.measure.mm };
      else {
        this.measure.b = q;
        this.mode = "view";
        this.applyScale();
        this.renderPanel();
        (this.panel.querySelector('input[type="number"]') as HTMLInputElement | null)?.focus();
      }
      this.draw();
      return;
    }
    if (this.mode !== "view") return;
    // 가장 작은, 눌린 구멍을 켜고 끄기
    let best: { id: string; area: number } | null = null;
    for (const v of this.res.analysis.views) {
      if (!this.choice.roles[v.id]) continue;
      for (const hl of v.holes) {
        const [x0, y0, x1, y1] = hl.box;
        const m = 4 / this.cam.k;
        if (p[0] >= x0 - m && p[0] <= x1 + m && p[1] >= y0 - m && p[1] <= y1 + m) {
          const area = (x1 - x0) * (y1 - y0);
          if (!best || area < best.area) best = { id: hl.id, area };
        }
      }
    }
    if (best) {
      this.choice.holes[best.id] = !this.choice.holes[best.id];
      this.renderPanel();
      this.draw();
    }
  }

  /** 재기 점은 가까운 외형선 꼭짓점·뷰 모서리에 붙인다 */
  private snapPoint(p: P2): P2 {
    if (!this.res) return p;
    const r = 10 / this.cam.k;
    let best: P2 = p;
    let bd = r;
    for (const v of this.res.analysis.views) {
      const pts: P2[] = [
        [v.box[0], v.box[1]],
        [v.box[2], v.box[1]],
        [v.box[2], v.box[3]],
        [v.box[0], v.box[3]],
      ];
      if (v.outline.kind === "path") for (const pr of v.outline.prims) pts.push(pr.a);
      for (const q of pts) {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d < bd) (bd = d), (best = q);
      }
    }
    return best;
  }

  draw() {
    const c = this.canvas;
    const r = c.parentElement!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) {
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    const { k, tx, ty } = this.cam;
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(k, k);
    if (this.mode === "corners" && this.src) {
      ctx.drawImage(rotated(this.src, this.rot), 0, 0);
      ctx.restore();
      const pts = this.handles.map((p) => [p[0] * k + tx, p[1] * k + ty]);
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.stroke();
      for (const p of pts) {
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(p[0], p[1], 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      return;
    }
    if (this.proc) ctx.drawImage(this.proc, 0, 0);
    ctx.restore();
    if (!this.res || !this.choice) return;
    const an = this.res.analysis;
    const S = (p: P2): [number, number] => [p[0] * k + tx, p[1] * k + ty];
    // 화면에서 뷰가 놓인 곳 (자동 시험용)
    c.dataset.views = JSON.stringify(
      an.views.filter((v) => this.choice!.roles[v.id]).map((v) => ({ role: this.choice!.roles[v.id], box: [...S([v.box[0], v.box[1]]), ...S([v.box[2], v.box[3]])] })),
    );
    for (const v of an.views) {
      const role = this.choice.roles[v.id];
      if (v.frame && !role) continue;
      const col = role ? ROLE_COLOR[role] : "#9ca3af";
      // 외형선
      ctx.lineWidth = role ? 2.5 : 1.5;
      ctx.strokeStyle = col;
      ctx.setLineDash(role ? [] : [6, 4]);
      tracePath(ctx, v.outline, S, k);
      ctx.stroke();
      ctx.setLineDash([]);
      // 이름표
      const [lx, ly] = S([v.box[0], v.box[1]]);
      const label = role ? VIEW_LABEL[role] + (this.choice.revolve && role === "front" ? " (회전 단면)" : "") : "쓰지 않음";
      ctx.font = "600 12px system-ui, sans-serif";
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = col;
      ctx.fillRect(lx, ly - 20, tw, 18);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, lx + 5, ly - 7);
      if (!role) continue;
      // 구멍
      for (const hl of v.holes) {
        const on = this.choice.holes[hl.id];
        ctx.lineWidth = 2;
        ctx.strokeStyle = on ? "#dc2626" : "#9ca3af";
        ctx.fillStyle = on ? "rgba(220,38,38,.18)" : "rgba(0,0,0,0)";
        ctx.setLineDash(on ? [] : [4, 3]);
        tracePath(ctx, hl.fit, S, k);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // 재기
    const m = this.measure;
    if (this.scaleMode === "length" && m.a) {
      const a = S(m.a);
      const b = m.b ? S(m.b) : this.mode === "measure" && this.hover ? S(this.snapPoint(this.hover)) : null;
      ctx.strokeStyle = "#7c3aed";
      ctx.fillStyle = "#7c3aed";
      ctx.lineWidth = 2;
      if (b) {
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
        if (m.b && m.mm) {
          ctx.font = "600 13px system-ui, sans-serif";
          ctx.fillText(`${m.mm} mm`, (a[0] + b[0]) / 2 + 6, (a[1] + b[1]) / 2 - 6);
        }
      }
      for (const q of [a, b]) {
        if (!q) continue;
        ctx.beginPath();
        ctx.arc(q[0], q[1], 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (this.mode === "measure") {
      ctx.font = "600 13px system-ui, sans-serif";
      ctx.fillStyle = "#7c3aed";
      ctx.fillText(this.measure.a && !this.measure.b ? "두 번째 점을 찍으세요" : "첫 번째 점을 찍으세요 (꼭짓점에 붙어요)", 12, 22);
    }
  }
}

function tracePath(ctx: CanvasRenderingContext2D, f: Analysis["views"][number]["outline"], S: (p: P2) => [number, number], k: number) {
  ctx.beginPath();
  if (f.kind === "circle") {
    const [x, y] = S(f.c);
    ctx.arc(x, y, f.r * k, 0, Math.PI * 2);
    return;
  }
  if (f.kind === "slot") {
    const [ax, ay] = S(f.a);
    const [bx, by] = S(f.b);
    const ang = Math.atan2(by - ay, bx - ax);
    ctx.arc(bx, by, f.r * k, ang - Math.PI / 2, ang + Math.PI / 2);
    ctx.arc(ax, ay, f.r * k, ang + Math.PI / 2, ang + (3 * Math.PI) / 2);
    ctx.closePath();
    return;
  }
  f.prims.forEach((p, i) => {
    const a = S(p.a);
    if (i === 0) ctx.moveTo(a[0], a[1]);
    if (p.t === "line") {
      const b = S(p.b);
      ctx.lineTo(b[0], b[1]);
    } else {
      const c = S(p.c);
      const a0 = Math.atan2(p.a[1] - p.c[1], p.a[0] - p.c[0]);
      const a1 = Math.atan2(p.b[1] - p.c[1], p.b[0] - p.c[0]);
      const am = Math.atan2(p.m[1] - p.c[1], p.m[0] - p.c[0]);
      // 가운데 점을 지나는 방향으로
      const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const ccw = norm(am - a0) > norm(a1 - a0);
      ctx.arc(c[0], c[1], p.r * k, a0, a1, ccw);
    }
  });
  ctx.closePath();
}

function grayCanvas(g: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = g[i];
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function section(title: string, body: Node[]): HTMLElement {
  return h("div", {}, "imp-sec", [h("div", { textContent: title }, "imp-title"), ...body]);
}

function radio(name: string, label: string, checked: boolean, on: () => void): HTMLElement {
  const r = h("input", { type: "radio", name, checked });
  r.onchange = () => r.checked && on();
  return h("label", {}, "imp-check", [r, " ", label]);
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();
