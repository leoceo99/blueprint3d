/**
 * 3D 자동 생성: 프로젝트가 바뀌면 잠깐 기다렸다가(0.25초) 백그라운드 스레드에서 다시 만든다.
 * 끝나면 "built" 이벤트 (검사, 도면, 썸네일이 따라 움직임).
 */
import { geometryKey, type Part } from "../core/document";
import { VIEW_IDS, type BuildResult } from "../core/types";
import { engine } from "../engine";
import { getFile } from "../fileStore";
import { store } from "../store";
import { fmt } from "../ui/sketch";
import { fmtVol, unitLabel } from "../core/units";
import { ui } from "../ui/state";
import { app, emit, requestRender } from "./context";
import { $ } from "./dom";

let buildTimer = 0;
let buildSeq = 0;
let building: Promise<void> | null = null;
/** 마지막으로 3D를 만든 부품과 모양 (같으면 다시 만들지 않는다) */
let builtKey = "";
/** 다시 만든 횟수 (시험·성능 확인용) */
export const buildStats = { runs: 0, skipped: 0 };

/** 3D를 만들 때 쓸 부품 (13단계: 고르는 피처를 고치는 동안은 그 앞까지만) */
let transform: (p: Part) => Part = (p) => p;
export function setBuildTransform(fn: (p: Part) => Part) {
  transform = fn;
}
const projectToBuild = () => transform(store.project);

const keyOfActive = () => `${store.project.id}|${geometryKey(projectToBuild())}`;

/** 프로젝트가 바뀌면: 3D 모양이 바뀐 경우에만 다시 만든다 */
export function scheduleBuildIfChanged() {
  if (keyOfActive() === builtKey && !buildTimer) {
    buildStats.skipped++;
    return;
  }
  scheduleBuild();
}

export function scheduleBuild() {
  clearTimeout(buildTimer);
  setBuildStatus("3D 갱신 중…", "");
  buildTimer = window.setTimeout(() => {
    buildTimer = 0;
    building = runBuild();
  }, 250);
}

/** 기다리지 않고 바로 만들고 끝날 때까지 기다림 (AI 검토 전 등) */
export async function waitForBuild() {
  clearTimeout(buildTimer);
  buildTimer = 0;
  building = runBuild();
  await building;
}

async function runBuild() {
  const seq = ++buildSeq;
  buildStats.runs++;
  const key = keyOfActive();
  const source = store.project.source;
  const hasAny = !!source || !!store.project.features?.length || VIEW_IDS.some((v) => store.project.views[v].some((s) => !s.hole));
  if (!hasAny) {
    builtKey = key;
    app.lastBuild = null;
    app.buildError = undefined;
    app.featureLog = [];
    ui.result = null;
    app.viewer.setMesh(null);
    setBuildStatus("도형을 그리면 3D가 자동으로 만들어져요", "");
    finishBuild();
    return;
  }
  try {
    const res = source
      ? await engine.buildImported(structuredClone(source), () => getFile(source.key))
      : await engine.build(structuredClone(projectToBuild()));
    if (seq !== buildSeq) return;
    builtKey = key;
    app.lastBuild = res;
    app.buildError = undefined;
    app.featureLog = res.featureLog ?? [];
    app.viewer.setMesh(res.mesh);
    ui.result = Object.fromEntries(
      VIEW_IDS.map((v) => [
        v,
        {
          visible: res.projections[v].visible.map((d) => new Path2D(d)),
          hidden: res.projections[v].hidden.map((d) => new Path2D(d)),
          bounds: res.projections[v].bounds,
        },
      ]),
    ) as typeof ui.result;
    const [[x0, y0, z0], [x1, y1, z1]] = res.bbox;
    setBuildStatus(`✓ 3D ${fmt(x1 - x0)}×${fmt(y1 - y0)}×${fmt(z1 - z0)} ${unitLabel()}`, "ok");
    $("#info3d").textContent = `${fmt(x1 - x0)} × ${fmt(y1 - y0)} × ${fmt(z1 - z0)} ${unitLabel()} · 부피 ${fmtVol(res.volume)}`;
  } catch (e: any) {
    if (seq !== buildSeq) return;
    builtKey = key;
    app.lastBuild = null;
    app.featureLog = e.featureLog ?? [];
    // 피처 부품에 아직 몸체가 없는 것(스케치만 있음)은 오류가 아니라 시작 단계
    if (e.featureLog && !e.featureLog.some((x: { state: string }) => x.state === "error")) {
      app.buildError = undefined;
      ui.result = null;
      app.viewer.setMesh(null);
      setBuildStatus("스케치를 돌출·회전하면 3D가 만들어져요", "");
      $("#info3d").textContent = "아직 몸체 없음";
    } else {
      app.buildError = e.message;
      setBuildStatus("⚠ 3D 생성 실패", "err");
    }
  }
  finishBuild();
}

function finishBuild() {
  app.buildStamp++;
  const ov = $("#buildOverlay");
  ov.hidden = !app.buildError;
  ov.textContent = app.buildError ?? "";
  emit("built");
  requestRender();
}

function setBuildStatus(text: string, cls: string) {
  const el = $("#buildStatus");
  el.textContent = text;
  el.className = "build-status " + cls;
}

void building;

// ---------------- 다른 부품 (도면용) ----------------
const others = new Map<string, { key: string; result: Promise<BuildResult | null> }>();

/**
 * 도면이 참조하는 부품의 3D. 지금 편집 중인 부품이면 마지막 결과를,
 * 다른 부품이면 따로 만들어(내보내기용 모델은 그대로) 모양이 바뀔 때까지 기억해 둔다.
 */
export function buildPart(part: Part): Promise<BuildResult | null> {
  // 편집 중인 부품: 화면의 3D 결과를 그대로 (다시 만들어지면 "built" 이벤트로 도면도 다시)
  if (part.id === store.project.id) return Promise.resolve(app.lastBuild);
  const key = geometryKey(part);
  const hit = others.get(part.id);
  if (hit && hit.key === key) return hit.result;
  const hasAny = !!part.source || VIEW_IDS.some((v) => part.views[v].some((s) => !s.hole));
  const src = part.source;
  const result: Promise<BuildResult | null> = !hasAny
    ? Promise.resolve(null)
    : (src ? engine.buildImported(structuredClone(src), () => getFile(src.key), false) : engine.build(structuredClone(part), false)).catch(() => null);
  others.set(part.id, { key, result });
  return result;
}
