/** 제도판 색 (CSS 변수에서 읽음, 테마가 바뀌면 refreshColors) — sketch.ts에서 나눔 */
export interface Colors {
  bg: string;
  gridMinor: string;
  gridMajor: string;
  axis: string;
  solidFill: string;
  solidStroke: string;
  holeStroke: string;
  accent: string;
  guide: string;
  snap: string;
  text: string;
  error: string;
  warning: string;
  info: string;
  blindFill: string;
  result: string;
  boardBg: string;
  frame: string;
  frameLabelBg: string;
  cornerBg: string;
  underlayInk: string;
  cons: string;
  fullStroke: string;
}

function readColors(): Colors {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    bg: v("--canvas-bg"),
    gridMinor: v("--grid-minor"),
    gridMajor: v("--grid-major"),
    axis: v("--axis"),
    solidFill: v("--solid-fill"),
    solidStroke: v("--solid-stroke"),
    holeStroke: v("--hole-stroke"),
    accent: v("--accent"),
    guide: v("--guide"),
    snap: v("--snap"),
    text: v("--text-muted"),
    error: v("--sev-error"),
    warning: v("--sev-warning"),
    info: v("--sev-info"),
    blindFill: v("--blind-fill"),
    result: v("--result-line"),
    boardBg: v("--board-bg"),
    frame: v("--frame"),
    frameLabelBg: v("--frame-label-bg"),
    cornerBg: v("--corner-bg"),
    underlayInk: v("--underlay-ink"),
    cons: v("--cons"),
    fullStroke: v("--full-stroke"),
  };
}

let colors: Colors | null = null;
export function refreshColors() {
  colors = readColors();
}
export function palette(): Colors {
  if (!colors) colors = readColors();
  return colors;
}
