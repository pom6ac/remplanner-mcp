// F2-02: круг restore → save → reload для эталонов F2-01 и правки модели «как Node» (анонимно).
// Запуск вне песочницы после phase2-ui-refs.ts: node scripts/probes/phase2-restore-check.ts [--headed]
// Вход: .orca-reports/phase2-ui-refs/final-model.json, S12.json, S24.json. Вывод: .orca-reports/phase2-restore-check.json
// В модель пишутся только сущности бесплатных инструментов (эталоны F2-01 их и содержат).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Page } from "playwright-core";
import { launch, newAnonProject, buildBase, copyServer, saveAndReload, OUT_DIR } from "./phase2-lib.ts";

const COLLS = ["walls", "items", "pillars", "rulers", "comments", "zone_delimiters", "cables", "cables_socket", "pipes",
  "groups_items", "claddings", "rooms2"];

function counts(m: any) {
  const c: Record<string, number> = {};
  for (const k of COLLS) c[k] = m?.[k] ? Object.keys(m[k]).length : 0;
  return c;
}

/** Отделка по комнатам: что включено и ключевые поля. */
function finishes(m: any) {
  const out: any[] = [];
  for (const [rid, r] of Object.entries<any>(m?.rooms2 || {})) {
    out.push({
      rid, area: r.area,
      names: (r.zones || []).map((z: any) => z.name),
      floors: (r.floors || []).filter((f: any) => f.exist).map((f: any) => ({ cover: f.cover, f0offset: f.f0offset, w: f.width, h: f.height })),
      ceilings: (r.ceilings || []).filter((c: any) => c.exist).map((c: any) => ({ type: c.type, level: c.level, profile: c.profile })),
      decors: JSON.stringify(r.decors || []).length,
    });
  }
  return out.sort((a, b) => (b.area ?? 0) - (a.area ?? 0));
}

function demolition(m: any) {
  const out: any[] = [];
  for (const w of Object.values<any>(m?.walls || {})) {
    const holes = Object.values<any>(w.holes || {}).filter((h) => h.demount).map((h) => h.id);
    const sectors = Object.keys(w.sectors || {}).length;
    if (w.demount || sectors || holes.length) out.push({ id: w.id, plan: w.plan, demount: w.demount, sectors, holes });
  }
  return out;
}

/** restore модели в живом редакторе (с id текущего проекта) → draw({rooms:1}) → copy. */
async function restoreDraw(page: Page, model: any) {
  return page.evaluate((m) => {
    const w: any = window as any;
    const cur = w.project.copy("server");
    m.id = cur.id; m.plan_id = cur.plan_id;
    let err: string | null = null;
    try { w.$Project.restore(m, { reset: 1 }); w.$Project.draw({ rooms: 1 }); w.project.localSave(); } catch (e: any) { err = String(e?.stack || e).slice(0, 600); }
    return { err, model: JSON.parse(JSON.stringify(w.project.copy("server"))) };
  }, model);
}

function load(name: string) {
  const p = `${OUT_DIR}/${name}.json`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

async function main() {
  const final = load("final-model");
  if (!final) throw new Error(`нет ${OUT_DIR}/final-model.json — сначала phase2-ui-refs.ts`);
  const out: any = { date: new Date().toISOString() };
  const browser = await launch();
  try {
    // (а) круг для итоговой модели F2-01
    {
      const page = await newAnonProject(browser);
      const r = await restoreDraw(page, structuredClone(final));
      const saved = await saveAndReload(page);
      const re = await copyServer(page);
      out.a_roundtrip = {
        restore_error: r.err, save: saved,
        counts: { source: counts(final), after_draw: counts(r.model), after_reload: counts(re) },
        finishes: { source: finishes(final), after_reload: finishes(re) },
        demolition: { source: demolition(final), after_reload: demolition(re) },
      };
      await page.context().close();
    }
    // (б) правки «как Node» на нормализованной базе
    {
      const page = await newAnonProject(browser);
      const ids = await buildBase(page);
      const base = await copyServer(page);
      const m = structuredClone(base);
      const roomIdsBefore = Object.keys(m.rooms2 || {}).sort();
      const biggest = Object.values<any>(m.rooms2 || {}).sort((a, b) => b.area - a.area)[0];
      const patched: string[] = [];
      if (biggest) {
        if (biggest.zones?.[0]) { biggest.zones[0].name = "Гостиная"; patched.push("zones[0].name"); }
        if (biggest.floors?.[0]) Object.assign(biggest.floors[0], { exist: true, cover: "laminate", f0offset: 5, width: 120, height: 20, stitch_width: 0.5, type_laying: biggest.floors[0].type_laying }), patched.push("floors[0]");
        if (biggest.ceilings?.[0]) Object.assign(biggest.ceilings[0], { exist: true, type: "stretch_ceiling", level: 10 }), patched.push("ceilings[0]");
      }
      const part2 = ids["part2"] ? m.walls[ids["part2"]] : null;
      if (part2) { part2.demount = 1; part2.p1.demount = 1; part2.p2.demount = 1; part2.sectors = {}; patched.push("part2.demount"); }
      const top = ids["top"] ? m.walls[ids["top"]] : null;
      if (top) { top.sectors = { s1: { id: "s1", pc: { x: 100, y: -300 }, width: 100 } }; patched.push("top.sectors"); }
      // розетка из эталона S12, сдвинутая на 50 см вдоль той же грани
      const s12 = load("S12");
      const sock = s12 ? Object.values<any>(s12.diff?.items?.added || {})[0] : null;
      if (sock?.props?.pc) {
        const clone = structuredClone(sock);
        clone.props.id = "p2sock"; clone.props.pc = { x: sock.props.pc.x + 50, y: sock.props.pc.y };
        delete clone.props.id_wall; delete clone.props.wall_direction; delete clone.props.wall_line; delete clone.props.id_room;
        if (clone.id) clone.id = "p2sock";
        m.items = m.items || {}; m.items["p2sock"] = clone; patched.push("items.p2sock");
      }
      const s24 = load("S24");
      const ruler = s24 ? Object.values<any>(s24.diff?.rulers?.added || {})[0] : null;
      if (ruler) {
        const r2 = structuredClone(ruler); r2.id = "p2ruler"; r2.p1 = { x: 10, y: 110 }; r2.p2 = { x: 590, y: 110 };
        if (Array.isArray(m.rulers)) m.rulers.push(r2); else { m.rulers = m.rulers || {}; m.rulers["p2ruler"] = r2; }
        patched.push("rulers.p2ruler");
      }
      const r = await restoreDraw(page, m);
      const saved = await saveAndReload(page);
      const re = await copyServer(page);
      const sockAfter = re.items?.["p2sock"]?.props;
      out.b_node_patch = {
        patched, restore_error: r.err, save: saved,
        room_ids_stable: JSON.stringify(roomIdsBefore) === JSON.stringify(Object.keys(re.rooms2 || {}).sort()),
        finishes_after: finishes(re), demolition_after: demolition(re),
        socket_after: sockAfter ? { name: sockAfter.name, pc: sockAfter.pc, id_wall: sockAfter.id_wall, wall_direction: sockAfter.wall_direction, over_floor: sockAfter.over_floor } : null,
        rulers_after: re.rulers ? Object.keys(re.rulers).length : 0,
      };
      // (в) сдвиг перегородки part1 на 20 см после отделки → что стало с отделкой
      {
        const m2 = structuredClone(re);
        const p1w = ids["part1"] ? m2.walls[ids["part1"]] : null;
        if (p1w) { p1w.p1.x += 20; p1w.p2.x += 20; for (const k of ["l1", "l2", "r1", "r2"]) if (p1w[k]) p1w[k].x += 20; }
        const r3 = await restoreDraw(page, m2);
        out.c_wall_move = { restore_error: r3.err, finishes_before: finishes(re), finishes_after: finishes(r3.model) };
      }
      await page.context().close();
    }
  } finally {
    writeFileSync(".orca-reports/phase2-restore-check.json", JSON.stringify(out, null, 1) + "\n");
    await browser.close().catch(() => {});
  }
  console.log(JSON.stringify({ a: out.a_roundtrip?.counts, b_room_ids_stable: out.b_node_patch?.room_ids_stable, b_socket: out.b_node_patch?.socket_after }, null, 1));
}

await main();
