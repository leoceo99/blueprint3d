// 14.1~14.3: 도면 뷰 2.0 — 단면(절단선 두 점) → 해칭·절단선·이름, 뒤집기, 상세(원) 배율, 등각, 뷰 옮기기·지우기, 기본 뷰 숨기기, 실행 취소
const { out, launch, finish, fresh, waitBuild } = require('./lib.cjs');
(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  const results = [];
  const ok = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`);
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  const B = (fn, arg) => page.evaluate(fn, arg);
  const run = (id) => B((i) => window.blueprint3d.commands.run(i), id);
  const views = () => B(() => { const s = window.blueprint3d.store; const d = s.doc.drawings.find((x) => x.id === s.doc.view.drawing); return JSON.parse(JSON.stringify(d?.views ?? [])); });
  const sheet = () => B(() => { const sh = window.blueprint3d.app.lastSheet; return sh && { views: sh.views, texts: sh.texts.map((t) => t.text), hatch: sh.prims.filter((p) => p.layer === 'HATCH').length, scale: sh.scale }; });
  /** 용지 좌표 → 화면 */
  const scr = (p) => B(([x, y]) => {
    const svg = document.querySelector('#sheetHost svg');
    const H = svg.viewBox.baseVal.height;
    const pt = svg.createSVGPoint(); pt.x = x; pt.y = H - y;
    const q = pt.matrixTransform(svg.getScreenCTM());
    return [q.x, q.y];
  }, p);
  const waitSheet = async (pred, arg) => { await page.waitForFunction(pred, arg, { timeout: 60000 }); await page.waitForTimeout(300); };
  try {
    await fresh(page);
    await waitBuild(page);
    // 플랜지(회전체 + 볼트 구멍) — 단면이 쓸모 있는 부품
    await run('sample.2');
    await waitBuild(page);
    await page.keyboard.press('3');
    await waitSheet(() => document.querySelectorAll('#sheetHost svg g.dim').length > 2);
    let sh = await sheet();
    const fb = sh.views.front.box;
    const cx = (fb[0] + fb[2]) / 2;

    // ---- 단면: 정면도 가운데 세로선 ----
    await page.keyboard.press('s');
    let [x1, y1] = await scr([cx, fb[1] - 3]);
    let [x2, y2] = await scr([cx + 0.4, fb[3] + 3]);
    await page.mouse.click(x1, y1);
    await page.mouse.click(x2, y2);
    await waitSheet(() => (window.blueprint3d.app.lastSheet?.prims ?? []).some((p) => p.layer === 'HATCH'));
    let v = await views();
    sh = await sheet();
    ok('단면 도구: 두 점 → 단면 A-A (5° 안쪽은 세로로 바로잡음)', v.length === 1 && v[0].kind === 'section' && v[0].label === 'A' && Math.abs(v[0].a[0] - v[0].b[0]) < 1e-9, JSON.stringify(v[0]));
    ok('단면도: 해칭 + “단면 A-A” + 정면도에 절단선 문자', sh.hatch > 5 && sh.texts.includes('단면 A-A') && sh.texts.filter((t) => t === 'A').length === 2, `hatch=${sh.hatch}`);
    await page.screenshot({ path: out('sheet-section.png') });

    // ---- 뒤집기 ----
    await page.click('#viewList [data-vflip]');
    await page.waitForTimeout(1200);
    ok('보는 방향 뒤집기', (await views())[0].flip === true);

    // ---- 상세도: 정면도 모서리 ----
    await page.keyboard.press('c');
    [x1, y1] = await scr([fb[2] - 4, fb[3] - 4]);
    [x2, y2] = await scr([fb[2] - 4 + 8, fb[3] - 4]);
    await page.mouse.click(x1, y1);
    await page.mouse.click(x2, y2);
    await waitSheet(() => (window.blueprint3d.app.lastSheet?.texts ?? []).some((t) => /^상세 B/.test(t.text)));
    v = await views();
    ok('상세 도구: 원 → 상세 B (2:1)', v[1]?.kind === 'detail' && v[1].k === 2 && (await sheet()).texts.includes('상세 B (2:1)'), JSON.stringify(v[1]));
    await page.selectOption(`#viewList select[data-vk="${v[1].id}"]`, '5');
    await waitSheet(() => (window.blueprint3d.app.lastSheet?.texts ?? []).some((t) => t.text === '상세 B (5:1)'));
    sh = await sheet();
    ok('상세 배율 5:1 → 그 뷰 척도 = 도면 × 5', Math.abs(sh.views[v[1].id].s - sh.scale * 5) < 1e-9);

    // ---- 등각 ----
    await page.keyboard.press('i');
    await waitSheet(() => (window.blueprint3d.app.lastSheet?.texts ?? []).includes?.('등각 그림') || (window.blueprint3d.app.lastSheet?.texts ?? []).some((t) => t.text === '등각 그림'));
    ok('등각 그림 넣기', (await views()).some((x) => x.kind === 'iso'));

    // ---- 뷰 옮기기 (끌기) ----
    sh = await sheet();
    const ib = sh.views[(await views()).find((x) => x.kind === 'iso').id].box;
    const [ix, iy] = await scr([(ib[0] + ib[2]) / 2, (ib[1] + ib[3]) / 2]);
    await page.mouse.move(ix, iy);
    await page.mouse.down();
    const [tx, ty] = await scr([(ib[0] + ib[2]) / 2 - 15, (ib[1] + ib[3]) / 2 - 10]);
    await page.mouse.move(tx, ty, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const iso = (await views()).find((x) => x.kind === 'iso');
    ok('뷰를 끌어 옮기면 그 자리 기억', Array.isArray(iso.at) && Math.abs(iso.at[0] - ((ib[0] + ib[2]) / 2 - 15)) < 1.5, JSON.stringify(iso.at));

    // ---- 기본 뷰 숨기기 ----
    await page.uncheck('#viewStd input[data-std="top"]');
    await waitSheet(() => !window.blueprint3d.app.lastSheet?.views?.top);
    ok('평면도 숨기기', !(await sheet()).views.top);

    // ---- 지우기 (상세 B는 단면 A를 부모로 하지 않음 → 단면만 지워짐) + 실행 취소 ----
    await page.click(`#viewList [data-vdel="${(await views())[0].id}"]`);
    await waitSheet(() => !(window.blueprint3d.app.lastSheet?.prims ?? []).some((p) => p.layer === 'HATCH'));
    ok('단면도 지우기', !(await views()).some((x) => x.kind === 'section'));
    await page.keyboard.press('Control+z');
    await waitSheet(() => (window.blueprint3d.app.lastSheet?.prims ?? []).some((p) => p.layer === 'HATCH'));
    ok('실행 취소로 되살림', (await views()).some((x) => x.kind === 'section'));

    // ---- 단면도 위에 치수 직접 놓기 ----
    sh = await sheet();
    const sid = (await views()).find((x) => x.kind === 'section').id;
    const pts = await B((id) => {
      const sh = window.blueprint3d.app.lastSheet;
      const b = sh.views[id].box;
      // 그 뷰 안의 외형선 끝점 두 개 (가로로 가장 먼 것)
      const ends = sh.prims.filter((p) => p.layer === 'VISIBLE' && p.t === 'line').flatMap((p) => [p.a, p.b]).filter((q) => q[0] >= b[0] - 0.1 && q[0] <= b[2] + 0.1 && q[1] >= b[1] - 0.1 && q[1] <= b[3] + 0.1);
      ends.sort((a, c) => a[0] - c[0] || a[1] - c[1]);
      return [ends[0], ends[ends.length - 1], b];
    }, sid);
    await page.keyboard.press('d');
    await page.waitForTimeout(1000); // 도구를 바꾸면 도면을 다시 그림
    for (const q of [pts[0], pts[1], [(pts[0][0] + pts[1][0]) / 2, pts[2][1] - 8]]) {
      const [x, y] = await scr(q);
      await page.mouse.click(x, y);
    }
    await page.waitForTimeout(800);
    const manual = await B(() => { const s = window.blueprint3d.store; const d = s.doc.drawings.find((x) => x.id === s.doc.view.drawing); return d.edits?.dims ?? []; });
    ok('단면도에도 치수 놓기 (그 뷰 좌표로)', manual.some((d) => d.view === sid), JSON.stringify(manual.map((d) => d.view)));
    await page.keyboard.press('Escape');
    await page.screenshot({ path: out('sheet-views.png') });
  } catch (e) {
    results.push('FAIL exception — ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
    await page.screenshot({ path: out('sheetviews-error.png') }).catch(() => {});
  }
  finish(results, errs);
  await browser.close();
})();
