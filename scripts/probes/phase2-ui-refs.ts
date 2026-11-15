// F2-01: съём эталонов фазы 2 из UI редактора (анонимный проект, аккаунт не используется).
// Запуск вне песочницы: node scripts/probes/phase2-ui-refs.ts [--headed] [--only=S05,S12]
// Вывод (вне git): .orca-reports/phase2-ui-refs/{summary,final-model,<сценарий>}.json и <сценарий>.png
//
// База — «коридор + 3 комнаты» T24 (см, Y вниз): оси x∈[0,600], y∈[−300,120], коридор y=0, перегородки x=300, x=500,
// толщина 20. Комната A — x∈[10,290], y∈[−290,−10]; коридор — y∈[10,110].
// PRO-инструменты не кликаются (класс is_pro) — записываются как blocked:"pro". В модель анонимного проекта
// PRO-сущности не пишутся (AGENTS.md, правило 5).
import type { Page } from "playwright-core";
import {
  launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, escape, clickAt, dragAt, setMenuField,
  diffModels, writeOut, shot, saveAndReload, proKeys, clearFog, arg,
} from "./phase2-lib.ts";
import type { P } from "./phase2-lib.ts";

type Step =
  | { tool: string }
  | { footer: string }
  | { click: P }
  | { rclick: P }
  | { drag: [P, P] }
  | { field: string; value: string }
  | { esc: true };
type Scenario = { id: string; sheet: string; title: string; steps: Step[] };

const A_TOP_FACE = -290; // внутренняя грань верхней стены комнаты A

const SCENARIOS: Scenario[] = [
  { id: "S00", sheet: "init", title: "дверь на стене коридора (база для S03, S08)", steps: [{ tool: "door" }, { click: { x: 150, y: 0 } }, { esc: true }] },
  { id: "S01", sheet: "break_walls", title: "демонтаж стены целиком", steps: [{ tool: "break" }, { click: { x: 500, y: -150 } }, { esc: true }] },
  { id: "S02", sheet: "break_walls", title: "демонтаж участка стены", steps: [{ tool: "break_part" }, { drag: [{ x: 50, y: -300 }, { x: 150, y: -300 }] }, { esc: true }] },
  { id: "S03", sheet: "break_walls", title: "демонтаж проёма", steps: [{ tool: "break_door" }, { click: { x: 150, y: 0 } }, { esc: true }] },
  { id: "S04", sheet: "break_walls", title: "отмена демонтажа стены", steps: [{ tool: "remove_break" }, { click: { x: 500, y: -150 } }, { esc: true }] },
  { id: "S05", sheet: "create_walls", title: "перегородка из ГКЛ", steps: [{ tool: "wall_create_gypsum" }, { drag: [{ x: 150, y: -290 }, { x: 150, y: -10 }] }, { esc: true }] },
  { id: "S05b", sheet: "create_walls", title: "коды материалов ПГБ, пеноблок, кирпич", steps: [
    { tool: "wall_create_pgb" }, { drag: [{ x: 350, y: -290 }, { x: 350, y: -150 }] }, { esc: true },
    { tool: "wall_create_blocks" }, { drag: [{ x: 400, y: -290 }, { x: 400, y: -150 }] }, { esc: true },
    { tool: "wall_create_bricks" }, { drag: [{ x: 450, y: -290 }, { x: 450, y: -150 }] }, { esc: true },
  ] },
  { id: "S06", sheet: "create_walls", title: "ГКЛ-короб", steps: [{ tool: "gypsum_box" }, { click: { x: 30, y: -270 } }, { esc: true }] },
  { id: "S07", sheet: "create_walls", title: "зонирование коридора", steps: [{ tool: "zone" }, { drag: [{ x: 300, y: 10 }, { x: 300, y: 110 }] }, { esc: true }] },
  { id: "S08", sheet: "create_walls", title: "замена двери проёмом без двери", steps: [{ tool: "doorway" }, { click: { x: 150, y: 0 } }, { esc: true }] },
  { id: "S09", sheet: "init", title: "стояки у стены", steps: [
    { tool: "drainage_column" }, { click: { x: 12, y: -280 } }, { esc: true },
    { tool: "water_column_cold" }, { click: { x: 12, y: -250 } }, { esc: true },
  ] },
  { id: "S10", sheet: "waterplan", title: "вывод ХВС+ГВС, высота 60", steps: [
    { tool: "waterspot_cold_hot" }, { click: { x: 288, y: -150 } }, { esc: true },
    { rclick: { x: 288, y: -150 } }, { field: "#cm-waterspot--water-over-floor, #cm-waterspot--over-floor", value: "60" }, { esc: true },
  ] },
  { id: "S11", sheet: "waterplan", title: "вывод ХВС+ГВС+канализация, канализация 30", steps: [
    { tool: "waterspot_drainage_cold_hot" }, { click: { x: 288, y: -100 } }, { esc: true },
    { rclick: { x: 288, y: -100 } }, { field: "#cm-waterspot--drainage-over-floor", value: "30" }, { esc: true },
  ] },
  { id: "S12", sheet: "sockets", title: "розетка на верхней стене комнаты A", steps: [{ tool: "socket" }, { click: { x: 100, y: A_TOP_FACE + 2 } }, { esc: true }] },
  { id: "S13", sheet: "sockets", title: "группа розеток и второй контур", steps: [
    { tool: "socket" }, { click: { x: 107, y: A_TOP_FACE + 2 } }, { esc: true },
    { tool: "socket" }, { click: { x: 100, y: A_TOP_FACE + 14 } }, { esc: true },
  ] },
  { id: "S14", sheet: "sockets", title: "вывод под освещение и электрощиток", steps: [
    { tool: "wire_light" }, { click: { x: 200, y: 12 } }, { esc: true },
    { tool: "electric_shield" }, { click: { x: 12, y: 60 } }, { esc: true },
  ] },
  { id: "S15", sheet: "light_connections", title: "2-клавишный выключатель у двери", steps: [{ tool: "light_switch_double" }, { click: { x: 110, y: 12 } }, { esc: true }] },
  { id: "S16", sheet: "light", title: "люстра по центру, точечный, бра", steps: [
    { tool: "chandelier" }, { click: { x: 150, y: -150 } }, { esc: true },
    { tool: "lightspot" }, { click: { x: 450, y: 60 } }, { esc: true },
    { tool: "bra" }, { click: { x: 12, y: -150 } }, { esc: true },
  ] },
  { id: "S17", sheet: "rooms", title: "имя помещения", steps: [{ rclick: { x: 150, y: -150 } }, { field: "#cm-room2--zone-name", value: "Спальня" }, { esc: true }] },
  { id: "S18", sheet: "floor", title: "ламинат, подъём 5, плашка 120×20", steps: [
    { tool: "laminate" }, { click: { x: 200, y: -200 } }, { esc: true },
    { rclick: { x: 200, y: -200 } }, { field: "#cm-floor--floor0-offset", value: "5" },
    { field: "#cm-floor--width", value: "120" }, { field: "#cm-floor--height", value: "20" }, { esc: true },
  ] },
  { id: "S19", sheet: "floor", title: "плитка в коридоре, укладка", steps: [
    { tool: "floor_tile" }, { click: { x: 450, y: 60 } }, { esc: true },
    { rclick: { x: 450, y: 60 } }, { field: "#cm-floor--angle", value: "45" }, { esc: true },
  ] },
  { id: "S20", sheet: "ceiling", title: "натяжной потолок, опуск 10", steps: [
    { tool: "stretch_ceiling" }, { click: { x: 200, y: -200 } }, { esc: true },
    { rclick: { x: 200, y: -200 } }, { field: "#cm-ceiling--level", value: "10" }, { esc: true },
  ] },
  { id: "S21", sheet: "ceiling", title: "двухуровневый потолок в коридоре", steps: [{ tool: "complex_ceiling" }, { click: { x: 450, y: 60 } }, { esc: true }] },
  { id: "S22", sheet: "walls", title: "покраска всей комнаты", steps: [{ tool: "paint_wall" }, { click: { x: 150, y: -150 } }, { esc: true }] },
  { id: "S23", sheet: "walls", title: "плитка на одной стене, 85/60", steps: [
    { tool: "wall_tile" }, { click: { x: 13, y: -150 } }, { esc: true },
    { rclick: { x: 13, y: -150 } }, { field: "#cm-wall_decor--over-floor", value: "85" }, { field: "#cm-wall_decor--height", value: "60" }, { esc: true },
  ] },
  { id: "S24", sheet: "init", title: "размерная линия", steps: [{ footer: ".footer_bar_tool.ruler" }, { drag: [{ x: 10, y: -290 }, { x: 290, y: -290 }] }, { esc: true }] },
];

async function runStep(page: Page, s: Step): Promise<string | null> {
  if ("tool" in s) {
    const st = await pickTool(page, s.tool);
    return st === "ok" ? null : `${s.tool}: ${st}`;
  }
  if ("footer" in s) {
    const ok = await page.evaluate((sel) => { const el: any = document.querySelector(sel); if (!el) return false; el.click(); return true; }, s.footer);
    await page.waitForTimeout(500);
    return ok ? null : `${s.footer}: missing`;
  }
  if ("click" in s) { await clickAt(page, s.click); return null; }
  if ("rclick" in s) { await clickAt(page, s.rclick, "right"); return null; }
  if ("drag" in s) { await dragAt(page, s.drag[0], s.drag[1]); return null; }
  if ("field" in s) {
    for (const sel of s.field.split(",").map((x) => x.trim())) if (await setMenuField(page, sel, s.value)) return null;
    return `поле ${s.field} не видно`;
  }
  if ("esc" in s) { await escape(page); return null; }
  return "неизвестный шаг";
}

function createdIds(diff: Record<string, any>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(diff)) if (v && v.added) { const ids = Object.keys(v.added); if (ids.length) out[k] = ids; }
  return out;
}

async function main() {
  const only = arg("only")?.split(",");
  const browser = await launch();
  const summary: any = { date: new Date().toISOString(), scenarios: {} };
  try {
    const page = await newAnonProject(browser);
    summary.global_version = await page.evaluate(() => (window as any).global_version);
    summary.object_id = await page.evaluate(() => document.body.getAttribute("data-object-id"));
    summary.pro_keys = await proKeys(page);
    summary.base_ids = await buildBase(page);
    await shot(page, "base");
    const created: Record<string, Record<string, string[]>> = {};
    for (const sc of SCENARIOS) {
      if (only && !only.includes(sc.id)) continue;
      const res: any = { title: sc.title, sheet: sc.sheet, problems: [] as string[] };
      try {
        await switchSheet(page, sc.sheet);
        const before = await copyServer(page);
        for (const st of sc.steps) {
          const p = await runStep(page, st);
          if (p) res.problems.push(p);
          if (p && p.endsWith(": pro")) { res.blocked = "pro"; break; }
        }
        await clearFog(page);
        await page.evaluate(() => { try { (window as any).project.localSave(); } catch { /* */ } });
        const after = await copyServer(page);
        const diff = diffModels(before, after);
        res.changed = Object.keys(diff);
        res.created = createdIds(diff);
        res.ok = !res.blocked && res.changed.length > 0;
        created[sc.id] = res.created;
        writeOut(sc.id, { _source: `phase2-ui-refs ${sc.id} (${sc.title}), лист ${sc.sheet}, global_version ${summary.global_version}, анонимный проект`, steps: sc.steps, diff });
        await shot(page, sc.id);
      } catch (e: any) {
        res.ok = false;
        res.error = String(e?.stack || e).slice(0, 500);
      }
      summary.scenarios[sc.id] = res;
      console.log(sc.id, JSON.stringify({ ok: res.ok, changed: res.changed, problems: res.problems, error: res.error }));
    }
    const final = await copyServer(page);
    writeOut("final-model", final);
    const saved = await saveAndReload(page);
    const reloaded = await copyServer(page);
    const missing: string[] = [];
    for (const [sid, cols] of Object.entries(created)) {
      for (const [col, ids] of Object.entries(cols)) {
        const coll = reloaded[col] || {};
        for (const id of ids) if (!(id in coll)) missing.push(`${sid}:${col}:${id}`);
      }
    }
    summary.roundtrip = { save: saved, missing };
    writeOut("reloaded-model", reloaded);
  } finally {
    writeOut("summary", summary);
    await browser.close().catch(() => {});
  }
  console.log("summary:", `${Object.values<any>(summary.scenarios).filter((s) => s.ok).length}/${Object.keys(summary.scenarios).length} ok;`,
    "missing after reload:", summary.roundtrip?.missing?.length ?? "n/a");
}

await main();
