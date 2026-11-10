/**
 * 작업 공간 ② 3D 설계: 3D 모델을 돌려 보고, 피처(스케치·돌출·회전·필렛·쉘·패턴…)를 쌓아 부품을 만든다 (13단계).
 * STL·STEP 저장도 여기서.
 */
import type { Command } from "../app/commands";
import { app, invalidatePanels } from "../app/context";
import { $ } from "../app/dom";
import { cancelEdit, fedit, finishEdit, newFeature, stopPlanePick } from "../app/featureEdit";
import { FEATURE_LABEL, type FeatureKind } from "../core/featureModel";
import type { Workspace } from "./registry";

const CAMS: [string, string, [number, number, number]][] = [
  ["iso", "등각", [1, -1.4, 0.9]],
  ["front", "정면", [0, -1, 0.0001]],
  ["top", "평면", [0, -0.0001, 1]],
  ["side", "우측", [1, 0, 0.0001]],
];

const cmds: Command[] = CAMS.map(([id, label, dir]) => ({
  id: `cam.${id}`,
  title: `3D 시점: ${label}`,
  category: "3D 보기",
  keywords: ["camera", "view", id],
  run: () => app.viewer.resetView(dir),
}));

/** 피처 단추 (리본 순서) — [종류, 단축키, 찾기 말] */
const FEATS: [FeatureKind, string, string[]][] = [
  ["sketch", "S", ["sketch", "plane", "스케치", "평면"]],
  ["extrude", "E", ["extrude", "pad", "pocket", "돌출", "밀어내기", "빼기"]],
  ["revolve", "R", ["revolve", "lathe", "회전", "선반"]],
  ["sweep", "W", ["sweep", "pipe", "hose", "스윕", "배관", "호스", "관"]],
  ["loft", "O", ["loft", "blend", "로프트"]],
  ["fillet", "F", ["fillet", "round", "필렛", "라운드", "둥글게"]],
  ["chamfer", "C", ["chamfer", "bevel", "모따기"]],
  ["shell", "T", ["shell", "hollow", "쉘", "속 비우기", "케이스"]],
  ["draft", "D", ["draft", "taper", "구배", "기울기"]],
  ["hole", "H", ["hole", "bolt", "tap", "구멍", "볼트", "탭"]],
  ["pattern", "P", ["pattern", "array", "패턴", "배열"]],
  ["mirror", "M", ["mirror", "symmetry", "대칭"]],
];

const featCmds: Command[] = [
  ...FEATS.map(([k, key, kw]) => ({
    id: `feat.${k}`,
    title: k === "sketch" ? "새 스케치 (평면 고르기)" : `${FEATURE_LABEL[k]} 피처`,
    category: "3D 설계",
    keywords: kw,
    keys: [key],
    run: () => void newFeature(k),
  })),
  { id: "feat.ok", title: "피처 확인", category: "3D 설계", keywords: ["ok", "apply", "확인"], keys: ["Enter"], enabled: () => !!fedit.id, run: finishEdit },
  {
    id: "feat.cancel",
    title: "피처 취소",
    category: "3D 설계",
    keywords: ["cancel", "취소"],
    enabled: () => !!fedit.id || fedit.plane,
    run: () => (fedit.plane ? stopPlanePick() : cancelEdit()),
  },
];

export const view3dWorkspace: Workspace = {
  id: "3d",
  title: "3D 설계",
  icon: "◈",
  order: 20,
  hint: "피처(스케치·돌출·회전·필렛·쉘·패턴…)로 부품 만들기 · 3D 보기 · STL·STEP 저장",
  show() {
    $("#ws-main").hidden = false;
    $("#stage-3d").hidden = false;
    $("#ribbon3d").hidden = false;
    document.body.classList.add("ws-3d");
    app.viewer.setActive(true);
    invalidatePanels();
  },
  hide() {
    finishEdit();
    stopPlanePick();
    app.viewer.setActive(false);
    $("#stage-3d").hidden = true;
    $("#ribbon3d").hidden = true;
    document.body.classList.remove("ws-3d");
    $("#ws-main").hidden = true;
  },
  commands: [...cmds, ...featCmds],
};

export function initView3d() {
  for (const b of document.querySelectorAll<HTMLElement>("[data-cam]")) b.dataset.cmd = `cam.${b.dataset.cam}`;
}
