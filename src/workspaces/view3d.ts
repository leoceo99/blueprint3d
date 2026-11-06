/** 작업 공간 ② 3D 보기: 만들어진 3D 모델을 돌려 보고 STL·STEP으로 저장 */
import type { Command } from "../app/commands";
import { app } from "../app/context";
import { $ } from "../app/dom";
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

export const view3dWorkspace: Workspace = {
  id: "3d",
  title: "3D 보기",
  icon: "◈",
  order: 20,
  hint: "만들어진 3D 모델 보기 · STL·STEP 저장",
  show() {
    $("#ws-main").hidden = false;
    $("#stage-3d").hidden = false;
    app.viewer.setActive(true);
  },
  hide() {
    app.viewer.setActive(false);
    $("#stage-3d").hidden = true;
    $("#ws-main").hidden = true;
  },
  commands: cmds,
};

export function initView3d() {
  for (const b of document.querySelectorAll<HTMLElement>("[data-cam]")) b.dataset.cmd = `cam.${b.dataset.cam}`;
}
