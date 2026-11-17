// 94: разведка «Отделка» — шаг 3: нанесение отделки стен (wallpaper) разными кликами.
// Анонимный проект. Запуск: node scripts/probes/94-finish-wall.ts
import { launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt, writeOut, escape, shot, clearFog } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
const base = await copyServer(page);

await switchSheet(page, "walls");
console.log("pick:", await pickTool(page, "wallpaper"));
await shot(page, "94-wall-picked");

const attempts = [
  { label: "wall_axis_150_-300", p: { x: 150, y: -300 } },
  { label: "wall_face_150_-292", p: { x: 150, y: -292 } },
  { label: "wall_face_150_-288", p: { x: 150, y: -288 } },
];
const res: any = {};
let prev = base;
for (const a of attempts) {
  await clearFog(page);
  await clickAt(page, a.p);
  const after = await copyServer(page);
  const s = JSON.stringify(after);
  res[a.label] = {
    hasWallpaper: s.includes("wallpaper"),
    roomEdgeMaterial: Object.values<any>(after.rooms2 ?? {}).map((r) => (r.edges ?? []).map((e: any) => e.material)),
  };
  console.log(a.label, JSON.stringify(res[a.label]).slice(0, 400));
  // если применилось — выйдем и сохраним состояние
  if (res[a.label].hasWallpaper) {
    writeOut("94-wall-applied-" + a.label, { after, prev });
    await shot(page, "94-wall-applied");
    break;
  }
  prev = after;
  await escape(page);
}

// редакторский объект стены (live) — где живёт отделка
const liveWall = await page.evaluate(() => {
  const w: any = window as any;
  const id = Object.keys(w.WALLS ?? {})[0];
  const wall = w.WALLS[id];
  if (!wall) return null;
  const j = wall.toJSON ? wall.toJSON() : wall;
  return { id, keys: Object.keys(j), sectors: j.sectors, claddings: j.claddings, material: j.material };
});
writeOut("94-wall-live", liveWall);
console.log("liveWall:", JSON.stringify(liveWall).slice(0, 800));

await browser.close();
process.exit(0);
