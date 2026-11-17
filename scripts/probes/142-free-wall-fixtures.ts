// 142: эталоны свободностоящих стен — проба в анонимном проекте.
// Цели: (1) снять точную форму стен из редактора (project.copy("server")) для эталонов
// tests/fixtures/ui-ref-free-wall-partition.json (plan:"c") и ui-ref-free-wall-a.json (plan:"a");
// (2) проверить живым save, что редактор не удаляет и не портит свободные стены
// (отчёт 132 часть 1 — повторная проверка); (3) скриншоты в .orca-reports/tmp/.
// Watchdog 8 минут, таймауты, явный process.exit.
import { writeFileSync, mkdirSync } from "node:fs";
import { createAnonProject, loadModel } from "../../src/api.ts";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import type { SessionState } from "../../src/session.ts";

const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });

setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 8 * 60_000).unref();

async function main() {
  const session: SessionState = { cookies: [] };
  const created = await createAnonProject(session);
  console.log("anon project:", JSON.stringify(created));

  const editor = await openEditor(session, created.object_id, created.plan_id, 60_000, { anonymous: true });
  const page = editor.page;
  const shot = async (tag: string) => {
    await page.screenshot({ path: `${OUT}/142-free-${tag}.png`, fullPage: false });
  };

  try {
    await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null, { timeout: 60_000 });
    await page.waitForTimeout(2500);
    const clearFog = () => page.evaluate(() => {
      const f: any = document.querySelector("#planner_ui_message_fog");
      if (f && f.classList.contains("active") && !f.innerHTML.trim()) f.classList.remove("active");
      document.querySelectorAll(".planner_ui_message.active").forEach((e: any) => e.classList.remove("active"));
    });
    await clearFog();

    const pickTool = async (key: string) => page.evaluate((k) => {
      const el: any = document.querySelector(`#plannertool_${k}`);
      if (!el) return "missing";
      const group = el.closest(".tools_item, .subtools_item");
      if (el.classList.contains("is_pro") || (group && group.classList.contains("is_pro"))) return "pro-gate";
      const parent: any = el.closest(".subtools");
      if (parent && parent.id) { const op: any = document.querySelector(`[data-target="${parent.id}"]`); op?.click(); }
      el.click();
      return "ok";
    }, key);
    const sheet = async (s: string) => {
      await clearFog();
      await page.evaluate((ss) => { const nav: any = document.querySelector(`.groups_navi_item.plan_${ss}`); if (nav) nav.click(); }, s);
      await page.waitForTimeout(1200);
      await clearFog();
    };
    const drag = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
      await clearFog();
      await page.mouse.move(a.x, a.y, { steps: 4 });
      await page.waitForTimeout(200);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 14 });
      await page.mouse.up();
      await page.waitForTimeout(900);
    };
    const freeWalls = () => page.evaluate(() => {
      const m = (window as any).project.copy("server");
      const out: any = {};
      for (const [k, w] of Object.entries<any>(m.walls ?? {})) {
        if (!w.p1?.link && !w.p2?.link) out[k] = w;
      }
      return out;
    });
    const errorsCount = () => page.evaluate(() => (window as any).project.copy("server").errors ?? null);

    // 1. ГКЛ-перегородка со свободными концами (лист «Перегородки»)
    await sheet("create_walls");
    console.log("pick wall_create_gypsum:", await pickTool("wall_create_gypsum"));
    await drag({ x: 500, y: 300 }, { x: 500, y: 550 });
    await page.keyboard.press("Escape");
    await shot("1-partition");
    const partition = await freeWalls();
    console.log("free walls after partition:", JSON.stringify(Object.keys(partition)));

    // 2. обычная стена со свободными концами (лист «Исходный план»)
    await sheet("init");
    console.log("pick wall:", await pickTool("wall"));
    await drag({ x: 900, y: 300 }, { x: 900, y: 550 });
    await page.keyboard.press("Escape");
    await shot("2-wall");
    const both = await freeWalls();
    console.log("free walls after wall:", JSON.stringify(Object.keys(both)));
    const wallA = Object.fromEntries(Object.entries(both).filter(([k]) => !(k in partition)));
    console.log("errors before save:", JSON.stringify(await errorsCount()));

    // эталоны — точная форма из редактора
    writeFileSync("tests/fixtures/ui-ref-free-wall-partition.json", JSON.stringify({
      _source: "клики UI в анонимном проекте на пустой базе (проба 142-free-wall-fixtures, без save); id объектов редактора, координаты см (модель редактора project.copy(\"server\")); ГКЛ-перегородка с двумя свободными концами",
      walls: partition,
    }, null, 1) + "\n");
    writeFileSync("tests/fixtures/ui-ref-free-wall-a.json", JSON.stringify({
      _source: "клики UI в анонимном проекте на пустой базе (проба 142-free-wall-fixtures, без save); id объектов редактора, координаты см (модель редактора project.copy(\"server\")); обычная стена листа «Исходный план» с двумя свободными концами",
      walls: wallA,
    }, null, 1) + "\n");

    // 3. живой save со свободными стенами
    const sv = await editor.save();
    console.log("save:", JSON.stringify(sv));
    await shot("3-after-save");
    const errorsAfter = await errorsCount();
    const freeAfter = await freeWalls();
    console.log("errors after save:", JSON.stringify(errorsAfter));
    console.log("free walls after save:", JSON.stringify(Object.keys(freeAfter)));

    // 4. GET с сервера
    const got = await loadModel(session, editor.objectId, editor.planId);
    const g: any = got.model;
    const gFree: any = {};
    for (const [k, w] of Object.entries<any>(g.walls ?? {})) {
      if (!w.p1?.link && !w.p2?.link) gFree[k] = { plan: w.plan, role: w.role, material: w.material, depth: w.depth, height: w.height, p1: w.p1, p2: w.p2 };
    }
    writeFileSync(`${OUT}/142-free-server-get.json`, JSON.stringify({ walls: gFree, errors: g.errors ?? null }, null, 1) + "\n");
    console.log("server GET free walls:", JSON.stringify(Object.keys(gFree)));
    console.log("server GET errors:", JSON.stringify(g.errors ?? null));
    writeFileSync(`${OUT}/142-free-check.json`, JSON.stringify({
      partition_keys: Object.keys(partition), wall_a_keys: Object.keys(wallA),
      after_save_keys: Object.keys(freeAfter), server_get_keys: Object.keys(gFree),
      errors_after_save: errorsAfter, save: sv,
    }, null, 1) + "\n");
  } finally {
    await editor.close().catch(() => {});
    await closeBrowser().catch(() => {});
  }
  console.log("DONE");
  process.exit(0);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
