// 245: уточнение эталонов — wall_apron как слой 2; painting_tile с materialize demolines_2.
// Запуск по явному аргументу run (ревью 246 №8): код не выполняется при импорте.
import { launch, newAnonProject, buildBase, switchSheet, pickTool, clickAt, copyServer, escape, writeOut } from "./phase2-lib.ts";
import { writeFileSync } from "node:fs";

async function main(): Promise<void> {
  const browser = await launch();
  const page = await newAnonProject(browser);
  await buildBase(page);
  await switchSheet(page, "ceiling");
  await pickTool(page, "gypsum_ceiling");
  await clickAt(page, { x: 150, y: -150 });
  await escape(page);

  const geo = await page.evaluate(() => {
    const rooms = Object.values<any>((window as any).ROOMS2 ?? {});
    const room = rooms.find((r: any) => {
      const poly: any[] = r.polygon ?? [];
      if (poly.length < 3) return false;
      const cx = poly.reduce((s: number, p: any) => s + p.x, 0) / poly.length;
      const cy = poly.reduce((s: number, p: any) => s + p.y, 0) / poly.length;
      return cx > 100 && cx < 200 && cy > -200 && cy < -100;
    });
    const poly = room.polygon;
    let best = { len: -1, i: 0 };
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      if (l > best.len) best = { len: l, i };
    }
    const a = poly[best.i], b = poly[(best.i + 1) % poly.length];
    const nx = (b.y - a.y) / best.len, ny = -(b.x - a.x) / best.len;
    const cx = poly.reduce((s: number, p: any) => s + p.x, 0) / poly.length;
    const cy = poly.reduce((s: number, p: any) => s + p.y, 0) / poly.length;
    return { id: room.id, a, b, len: best.len, nx, ny, sgn: nx * (cx - (a.x + b.x) / 2) + ny * (cy - (a.y + b.y) / 2) > 0 ? 1 : -1 };
  });
  console.log("geo ok");

  const res = await page.evaluate((g) => {
    const w: any = window as any;
    const room = w.ROOMS2[g.id];
    const out: any = {};
    const along = (t: number) => ({ x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t });
    const ins = (t: number, d: number) => { const p = along(t); return { x: p.x + g.nx * d * g.sgn, y: p.y + g.ny * d * g.sgn }; };
    const mat = (a: any, n: number) => { const x = Array.isArray(a) ? a : []; while (x.length < n) x.push({ exist: false }); return x; };
    room.decors = mat(room.decors, room.edges.length);
    room.demolines = mat(room.demolines, room.edges.length).map((e: any, i: number) => ({ ...room.edges[i] }));
    room.demolines_2 = mat(room.demolines_2, room.edges.length).map((e: any, i: number) => ({ ...room.edges[i] }));
    // wall_apron как слой 2
    w.tool = "wall_apron";
    out.apron = w.$DecorLining.create_line(ins(0.3, 5), ins(0.7, 5), { ...room.edges[0], index: 0 }, g.id, 2, 0, "gray", "part", false);
    // painting_tile (создаст слои 1 и 2)
    w.tool = "painting_tile";
    out.ptile = w.$DecorLining.create_line(ins(0.3, 5), ins(0.7, 5), { ...room.edges[1], index: 1 }, g.id, 1, 1, "gray", "part", false);
    // wallpaper_tiles
    w.tool = "wallpaper_tiles";
    out.wtiles = w.$DecorLining.create_line(ins(0.3, 5), ins(0.7, 5), { ...room.edges[2], index: 2 }, g.id, 1, 2, "gray", "part", false);
    // потолочный плинтус
    room.ceilingMoldings = mat(room.ceilingMoldings, room.edges.length);
    w.tool = "molding";
    out.cmold = w.$CeilingLining.create_line(ins(0.3, 5), ins(0.7, 5), { ...room.edges[0], index: 0 }, g.id, 1, 0, "gray", "part", false);
    const brief = (arr: any) => (arr ?? []).map((e: any, i: number) => e?.exist ? { i, parts: Object.values(e.parts ?? {}).map((p: any) => ({
      type: p.type, layer: p.layer, line: p.line, line_wall: p.line_wall, distance: p.distance,
      height: p.height, height_from_floor: p.height_from_floor })) } : null).filter(Boolean);
    out.decors = brief(room.decors);
    out.ceilingMoldings = brief(room.ceilingMoldings);
    return out;
  }, geo);
  console.log(JSON.stringify(res, null, 1));
  writeOut("245f5-steps", res);

  const resp = page.waitForResponse((r) => r.url().includes("/save/"), { timeout: 30000 }).catch(() => null);
  await page.evaluate(() => { const w: any = window as any; try { w.project.localSave(); } catch { /* */ } w.project.save(false, true); });
  await resp;
  await page.waitForTimeout(5500);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null, { timeout: 60000 });
  await page.waitForTimeout(3000);
  const post = await copyServer(page);
  writeOut("245f5-post", post.rooms2?.[geo.id] ?? null);
  writeFileSync(".orca-reports/tmp/245f5-server.json", JSON.stringify(post, null, 1));
  await browser.close();
  process.exit(0);
}

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … " + process.argv[1] + " run");
  process.exit(0);
}
await main();
