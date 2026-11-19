// 245: эталоны «Отделка» ч.2 — один evaluate: редакторские части через $-менеджеры.
import { launch, newAnonProject, buildBase, switchSheet, pickTool, clickAt, copyServer, escape, writeOut } from "./phase2-lib.ts";
import { writeFileSync } from "node:fs";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);

await switchSheet(page, "ceiling");
console.log("gypsum pick:", await pickTool(page, "gypsum_ceiling"));
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
  return { id: room.id, a, b, len: best.len, nx, ny, sgn: nx * (cx - (a.x + b.x) / 2) + ny * (cy - (a.y + b.y) / 2) > 0 ? 1 : -1,
    nEdges: poly.length, ceilId: room.ceilings?.[0]?.id ?? null };
});
console.log("geo:", JSON.stringify(geo));
if (!geo.ceilId) { console.log("FATAL: потолок не создан"); await browser.close(); process.exit(1); }

const res = await page.evaluate((g) => {
  const w: any = window as any;
  const room = w.ROOMS2[g.id];
  const out: any = { steps: [] };
  const along = (t: number) => ({ x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t });
  const ins = (t: number, d: number) => { const p = along(t); return { x: p.x + g.nx * d * g.sgn, y: p.y + g.ny * d * g.sgn }; };
  const mat = (a: any, n: number) => { const x = Array.isArray(a) ? a : []; while (x.length < n) x.push({ exist: false }); return x; };
  const tryStep = (name: string, fn: () => unknown) => {
    try { out.steps.push({ step: name, result: fn() }); }
    catch (e) { out.steps.push({ step: name, error: String(e).slice(0, 250) }); }
  };

  tryStep("ceiling-molding", () => {
    room.ceilingMoldings = mat(room.ceilingMoldings, room.edges.length);
    w.tool = "molding";
    const ok = w.$CeilingLining.create_line(ins(0.3, 5), ins(0.7, 5), { ...room.edges[0], index: 0 }, g.id, 1, 0, "gray", "part", false);
    return { ok, part: JSON.parse(JSON.stringify(room.ceilingMoldings[0])) };
  });
  tryStep("floor-molding", () => {
    room.floorMoldings = mat(room.floorMoldings, room.edges.length);
    w.tool = "floor_molding_plastic";
    const ok = w.$FloorLining.create_line(ins(0.3, 6), ins(0.7, 6), { ...room.edges[0], index: 0 }, g.id, 1, 0, "gray", "part", false);
    return { ok, part: JSON.parse(JSON.stringify(room.floorMoldings[0])) };
  });
  tryStep("wall-apron", () => {
    room.decors = mat(room.decors, room.edges.length);
    w.tool = "wall_apron";
    const ok = w.$DecorLining.create_line(ins(0.3, 5), ins(0.7, 5), { ...room.edges[0], index: 0 }, g.id, 1, 0, "gray", "part", false);
    return { ok, part: JSON.parse(JSON.stringify(room.decors[0])) };
  });
  tryStep("painting-tile", () => {
    w.tool = "painting_tile";
    const ok = w.$DecorLining.create_line(ins(0.3, 5), ins(0.7, 5), { ...room.edges[1], index: 1 }, g.id, 1, 1, "gray", "part", false);
    return { ok, part: JSON.parse(JSON.stringify(room.decors[1])) };
  });
  tryStep("wallpaper-tiles", () => {
    w.tool = "wallpaper_tiles";
    const ok = w.$DecorLining.create_line(ins(0.3, 5), ins(0.7, 5), { ...room.edges[2], index: 2 }, g.id, 1, 2, "gray", "part", false);
    return { ok, part: JSON.parse(JSON.stringify(room.decors[2])) };
  });
  return out;
}, geo);
console.log(JSON.stringify(res, null, 1));
writeOut("245f4-steps", res);

const resp = page.waitForResponse((r) => r.url().includes("/save/"), { timeout: 30000 }).catch(() => null);
await page.evaluate(() => { const w: any = window as any; try { w.project.localSave(); } catch { /* */ } w.project.save(false, true); });
const r = await resp;
console.log("save:", r ? (await r.text()).slice(0, 80) : "none");
await page.waitForTimeout(5500);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null, { timeout: 60000 });
await page.waitForTimeout(3000);
const post = await copyServer(page);
writeOut("245f4-post", post.rooms2?.[geo.id] ?? null);
writeFileSync(".orca-reports/tmp/245f4-server.json", JSON.stringify(post, null, 1));
await browser.close();
process.exit(0);
