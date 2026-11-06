/**
 * 3D 자동 생성: 프로젝트가 바뀌면 잠깐 기다렸다가(0.25초) 백그라운드 스레드에서 다시 만든다.
 * 끝나면 "built" 이벤트 (검사, 도면, 썸네일이 따라 움직임).
 */
import { VIEW_IDS } from "../core/types";
import { engine } from "../engine";
import { getFile } from "../fileStore";
import { store } from "../store";
import { fmt } from "../ui/sketch";
import { ui } from "../ui/state";
import { app, emit, requestRender } from "./context";
import { $ } from "./dom";

let buildTimer = 0;
let buildSeq = 0;
let building: Promise<void> | null = null;

export function scheduleBuild() {
  clearTimeout(buildTimer);
  setBuildStatus("3D 갱신 중…", "");
  buildTimer = window.setTimeout(() => (building = runBuild()), 250);
}

/** 기다리지 않고 바로 만들고 끝날 때까지 기다림 (AI 검토 전 등) */
export async function waitForBuild() {
  clearTimeout(buildTimer);
  building = runBuild();
  await building;
}

async function runBuild() {
  const seq = ++buildSeq;
  const source = store.project.source;
  const hasAny = !!source || VIEW_IDS.some((v) => store.project.views[v].some((s) => !s.hole));
  if (!hasAny) {
    app.lastBuild = null;
    app.buildError = undefined;
    ui.result = null;
    app.viewer.setMesh(null);
    setBuildStatus("도형을 그리면 3D가 자동으로 만들어져요", "");
    finishBuild();
    return;
  }
  try {
    const res = source
      ? await engine.buildImported(structuredClone(source), () => getFile(source.key))
      : await engine.build(structuredClone(store.project));
    if (seq !== buildSeq) return;
    app.lastBuild = res;
    app.buildError = undefined;
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
    setBuildStatus(`✓ 3D ${fmt(x1 - x0)}×${fmt(y1 - y0)}×${fmt(z1 - z0)} mm`, "ok");
    $("#info3d").textContent = `${fmt(x1 - x0)} × ${fmt(y1 - y0)} × ${fmt(z1 - z0)} mm · 부피 ${fmt(res.volume / 1000)} cm³`;
  } catch (e: any) {
    if (seq !== buildSeq) return;
    app.lastBuild = null;
    app.buildError = e.message;
    setBuildStatus("⚠ 3D 생성 실패", "err");
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
