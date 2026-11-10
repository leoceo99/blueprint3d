/**
 * 3D 보기 (three.js)를 나중에 내려받는다 — 10단계 다듬기.
 * 첫 화면(2D 설계)에는 three.js가 필요 없으므로, 3D 화면을 열거나 썸네일·AI 검토 그림이 필요할 때 불러온다.
 * 불러오기 전에 받은 메시·테마·켜짐 상태는 기억해 두었다가 그대로 넘긴다.
 */
import type { MeshData } from "../core/types";
import type { PickHit, PickMode, Viewer3D } from "../ui/viewer";

export class LazyViewer {
  private real: Viewer3D | null = null;
  private loading: Promise<Viewer3D> | null = null;
  private mesh: MeshData | null = null;
  private dark = false;
  private active = false;
  // 13단계: 고르기·강조·스케치 선 (불러오기 전에 받은 것도 기억)
  private pick: PickMode = "none";
  private sel: [number[], number[]] = [[], []];
  private overlay: number[] | null = null;
  onPick: ((hit: PickHit, e: PointerEvent) => void) | null = null;
  isPlanar: ((face: number) => boolean) | null = null;

  constructor(private host: HTMLElement) {}

  /** 진짜 3D 보기 (처음이면 내려받아 만든다) */
  ready(): Promise<Viewer3D> {
    return (this.loading ??= import("../ui/viewer").then(({ Viewer3D }) => {
      const v = new Viewer3D(this.host);
      v.setDark(this.dark);
      v.setMesh(this.mesh);
      v.onPick = (h, e) => this.onPick?.(h, e);
      v.isPlanar = (f) => this.isPlanar?.(f) ?? true;
      v.setPickMode(this.pick);
      v.setSelection(...this.sel);
      v.setOverlay(this.overlay);
      if (this.active) v.setActive(true);
      this.real = v;
      return v;
    }));
  }

  get loaded() {
    return !!this.real;
  }

  setMesh(m: MeshData | null) {
    this.mesh = m;
    this.real?.setMesh(m);
    this.real?.setSelection(...this.sel);
  }

  setPickMode(m: PickMode) {
    this.pick = m;
    this.real?.setPickMode(m);
  }

  setSelection(faces: number[], edges: number[]) {
    this.sel = [faces, edges];
    this.real?.setSelection(faces, edges);
  }

  setOverlay(lines: number[] | null) {
    this.overlay = lines;
    this.real?.setOverlay(lines);
  }

  /** 시험용: 3D 점의 화면 좌표 */
  screenOf(p: [number, number, number]): [number, number] | null {
    return this.real?.screenOf(p) ?? null;
  }

  /** 시험용: 화면 좌표의 면·모서리 */
  pickAt(x: number, y: number, tol = 8): PickHit | null {
    return this.real?.pickAt(x, y, tol) ?? null;
  }

  setDark(dark: boolean) {
    this.dark = dark;
    this.real?.setDark(dark);
  }

  setActive(a: boolean) {
    this.active = a;
    if (this.real) this.real.setActive(a);
    else if (a) void this.ready();
  }

  resetView(dir?: [number, number, number]) {
    void this.ready().then((v) => v.resetView(dir));
  }

  /** 등각 시점 그림 (data URL) — 썸네일용 */
  async snapshot(w: number, h: number, type?: string, quality?: number, bg?: string): Promise<string | null> {
    if (!this.mesh) return null;
    return (await this.ready()).snapshot(w, h, type, quality, bg);
  }

  /** AI 검토용 PNG (base64) */
  async capture(): Promise<string | null> {
    if (!this.mesh) return null;
    return (await this.ready()).capture();
  }
}
