// 360 (сантехника ч.3): разведка UI в dev-объекте (env, платный тариф) — КЛИКИ БЕЗ
// СЕРВЕРНОГО SAVE (localSave; откат перезагрузкой + GET-сверка sig с бэкапом):
//   1) «Узел» (waterspot_node) — формат предмета и подключение трубы water_pipe
//      рисованием UI (тип вершины, props.pipes);
//   2) GroupWaterSpots: merge (waterspot_cold + waterspot_hot кликом на цель) и
//      unset (контекстное меню «Убрать») — имена, over_floor, габариты;
//   3) каскад: удаление вывода-вершины ластиком — что происходит с трубой.
// Гарды полные (probe-guard): READONLY обязателен, коллизий env нет, GET-пара,
// эталон контрольного проекта (без REF_INIT — отказ), бэкап цели ДО прогона,
// sig-сверка после отката; расхождение бэкапа — СТОП. node scripts/probes/360-ws-live-recon.ts run
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { loadModel } from "../../src/api.ts";
import { sig } from "./probe-sig.ts";
import { probeWriteEnv, assertTargetPair, readonlyGuard, readonlyRefPath, type ReadonlyGuard } from "./probe-guard.ts";
import { checkEditorPlanMatch } from "./probe-guard.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу run (ID из env)");
  process.exit(0);
}
const { objectId: OBJECT_ID, planId: PLAN_ID, readonlyId: READONLY_ID, readonlyPlanId: READONLY_PLAN_ID } = probeWriteEnv();
mkdirSync(".orca-reports/tmp", { recursive: true });
const OUT = ".orca-reports/tmp";
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 12 * 60_000).unref();

const session = { ...loadSession(STATE_PATH), account: true } as const;
let roGuard: ReadonlyGuard | null = null;

try {
  roGuard = await readonlyGuard(session, READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
  await assertTargetPair(session, OBJECT_ID, PLAN_ID);
  const before = await loadModel(session, OBJECT_ID, PLAN_ID);
  const backupPath = `.orca-reports/backup-${OBJECT_ID}-360-recon.json`;
  if (!existsSync(backupPath)) writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
  else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: Record<string, unknown> };
    if (sig(stored.model as Record<string, unknown>) !== sig(before.model as Record<string, unknown>)) {
      console.error("модель на сервере не совпадает с бэкапом разведки — СТОП");
      process.exit(1);
    }
  }
  await roGuard.assertUnchanged("recon-start");

  const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
  const page = editor.page;
  // гард: план в редакторе == серверу (fail-closed)
  const compat = await editor.compatInfo();
  checkEditorPlanMatch((compat as unknown as { plan_id?: unknown }).plan_id, PLAN_ID);
  console.log("гард «план в редакторе == серверу»: OK");

  const copy = () => page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
  const clearFog = () => page.evaluate(() => {
    const f: any = document.querySelector("#planner_ui_message_fog");
    if (f && f.classList.contains("active") && !f.innerHTML.trim()) f.classList.remove("active");
    document.querySelectorAll(".planner_ui_message.active").forEach((e: any) => e.classList.remove("active"));
  });
  const toScreen = (p: { x: number; y: number }) => page.evaluate((pp) => {
    const svg: any = document.querySelector("#main_svg");
    const r = svg.getBoundingClientRect();
    const q = svg.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
    return { x: r.x + ((pp.x - q[0]) * r.width) / q[2], y: r.y + ((pp.y - q[1]) * r.height) / q[3] };
  }, p);
  const clickAt = async (p: { x: number; y: number }) => {
    await clearFog();
    const s = await toScreen(p);
    await page.mouse.move(s.x - 6, s.y - 6);
    await page.mouse.move(s.x, s.y, { steps: 6 });
    await page.waitForTimeout(250);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(700);
  };
  const dragAt = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
    await clearFog();
    const s = await toScreen(a), e = await toScreen(b);
    await page.mouse.move(s.x, s.y, { steps: 4 });
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.mouse.move(e.x, e.y, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(800);
  };
  const pickTool = async (key: string) => {
    const r = await page.evaluate((k) => {
      const el: any = document.querySelector(`#plannertool_${k}`);
      if (!el) return "missing";
      const parent: any = el.closest(".subtools");
      if (parent && parent.id) { const op: any = document.querySelector(`[data-target="${parent.id}"]`); op?.click(); }
      el.click();
      return "ok";
    }, key);
    await page.waitForTimeout(500);
    return r;
  };
  const sheet = async (s: string) => {
    await clearFog();
    await page.evaluate((ss) => { const nav: any = document.querySelector(`.groups_navi_item.plan_${ss}`); if (nav) nav.click(); }, s);
    await page.waitForTimeout(1200);
    await clearFog();
  };
  const esc = () => page.keyboard.press("Escape");

  // пробная сцена: стены через конструктор редактора (localSave, без сервера)
  const base = await copy();
  const wallsKeys = Object.keys(base.walls ?? {});
  const rooms = Object.values<any>(base.rooms2 ?? {});
  const room = rooms[0]!;
  const poly = (room.polygon ?? []).map((p: any) => ({ x: p.x, y: p.y }));
  if (poly.length < 3) { console.log("FAIL: нет полигона комнаты"); process.exit(1); }
  const cx = poly.reduce((s: number, p: any) => s + p.x, 0) / poly.length;
  const cy = poly.reduce((s: number, p: any) => s + p.y, 0) / poly.length;
  // точки сцены в комнате (не совпадающие с существующими предметами)
  const A = { x: cx - 40, y: cy - 40 };
  const B = { x: cx + 40, y: cy - 40 };
  const WPT = { x: cx - 60, y: poly[0]!.y + 15 };

  await sheet("waterplan");
  const out: Record<string, unknown> = {};

  // 1. Узел: клик инструментом waterspot_node
  out.pick_node = await pickTool("waterspot_node");
  await clickAt(A);
  await esc();
  let snap = await copy();
  const nodeItems = Object.entries<any>(snap.items ?? {}).filter(([, v]) => v.name === "waterspot_node");
  out.node_items = nodeItems.map(([id, v]) => ({ id, ...v }));
  console.log("узел:", JSON.stringify(out.node_items));

  // 2. труба water_pipe рисованием: drag от узла A до B
  out.pick_pipe = await pickTool("water_pipe");
  await dragAt(A, B);
  await esc();
  snap = await copy();
  out.pipes = snap.pipes ?? null;
  out.node_after_pipe = Object.entries<any>(snap.items ?? {}).filter(([id]) => nodeItems.some(([nid]) => nid === id)).map(([id, v]) => ({ id, name: v.name, pipes: v.pipes ?? null }));
  console.log("pipe после drag:", JSON.stringify(out.pipes));
  console.log("узел после pipe:", JSON.stringify(out.node_after_pipe));

  // 3. merge: waterspot_cold у стены, затем waterspot_hot кликом на неё
  out.pick_cold = await pickTool("waterspot_cold");
  await clickAt(WPT);
  await esc();
  snap = await copy();
  const coldId = Object.entries<any>(snap.items ?? {}).find(([, v]) => v.name === "waterspot_cold")?.[0];
  out.cold_item = coldId ? { id: coldId, ...snap.items[coldId] } : null;
  out.pick_hot = await pickTool("waterspot_hot");
  await clickAt(WPT);
  await esc();
  snap = await copy();
  out.after_merge = coldId ? snap.items[coldId] : null;
  console.log("merge:", JSON.stringify(out.after_merge));

  // 4. unset: контекстное меню на комбинированном выводе
  if (coldId) {
    await clickAt(snap.items[coldId].pc);
    // правый клик для меню
    await clearFog();
    const s = await toScreen(snap.items[coldId].pc);
    await page.mouse.move(s.x, s.y, { steps: 4 });
    await page.mouse.click(s.x, s.y, { button: "right" });
    await page.waitForTimeout(600);
    const actions = await page.evaluate(() => Array.from(document.querySelectorAll("#cm-waterspot li")).filter((e: any) => e.offsetParent !== null).map((e: any) => ({ cls: e.className, action: e.getAttribute("action"), text: e.textContent?.trim()?.slice(0, 40) })));
    out.cm_waterspot = actions;
    console.log("cm-waterspot:", JSON.stringify(actions));
    const unsetBtn = await page.evaluate(() => {
      const b: any = document.querySelector('#cm-waterspot li.unset_element[action="waterspot_cold"]') ?? document.querySelector('#cm-waterspot [action="waterspot_cold"]');
      if (b && b.offsetParent !== null) { b.click(); return "clicked"; }
      return "missing";
    });
    out.unset_click = unsetBtn;
    await page.waitForTimeout(700);
    await esc();
    snap = await copy();
    out.after_unset = snap.items[coldId] ?? null;
    console.log("unset:", JSON.stringify(out.after_unset));
  }

  writeFileSync(`${OUT}/360-ws-live-recon.json`, JSON.stringify(out, null, 1) + "\n");

  // откат: перезагрузка страницы (localSave не пишет на сервер), GET-сверка sig
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  await editor.close().catch(() => {});
  const afterReload = await loadModel(session, OBJECT_ID, PLAN_ID);
  const sigOk = sig(afterReload.model as Record<string, unknown>) === sig(before.model as Record<string, unknown>);
  console.log("откат перезагрузкой, sig с бэкапом:", sigOk ? "OK" : "РАСХОЖДЕНИЕ — требуется восстановление");
  const roChanged = await roGuard.checkFinal("recon-final");
  console.log("контрольный проект:", roChanged ? "ИЗМЕНИЛСЯ" : "не изменился");
  process.exit(sigOk && !roChanged ? 0 : 1);
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 500));
  await closeBrowser().catch(() => {});
  process.exit(1);
}
