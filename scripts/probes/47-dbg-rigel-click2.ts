// 47-rigels: прицельные клики «Потолочный ригель» — по варианту, со снятием состояния после каждого шага.
// ID только из env. КЛИКИ ТОЛЬКО ЛОКАЛЬНО: project.save не вызывается.
// node scripts/probes/47-dbg-rigel-click2.ts <variant>  варианты: pillar, wall, between, free
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clearFog, clickAt, dragAt, escape, pickTool, switchSheet, copyServer, diffModels, type P } from "./phase2-lib.ts";

const OUT = ".orca-reports/47-rigels-ui";
const variant = process.argv[2] ?? "pillar";
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }

async function dump(page: Page, name: string, data: unknown) {
  writeFileSync(`${OUT}/dbg2-${variant}-${name}.json`, JSON.stringify(data, null, 1) + "\n");
  console.log(name, JSON.stringify(data).slice(0, 400));
}

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");

  const geo = await page.evaluate(() => {
    const m = (window as any).project.copy("server");
    const walls = Object.values<any>(m.walls ?? {});
    const pillars = Object.values<any>(m.pillars ?? {}).map((p) => ({ id: p.id, pc: p.pc, w: p.width, h: p.height }));
    const holesOf = (w: any) => Object.values<any>(w.holes ?? {});
    // стена для варианта wall: ось, сегмент без проёмов (запас 60)
    let wallSeg: { wall: string; a: P; b: P } | null = null;
    for (const w of walls) {
      const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
      if (len < 200) continue;
      const dx = (w.p2.x - w.p1.x) / len, dy = (w.p2.y - w.p1.y) / len;
      for (let s = 80; s <= len - 80; s += 10) {
        const okFrom = holesOf(w).every((h) => {
          const t = ((h.pc.x - w.p1.x) * dx + (h.pc.y - w.p1.y) * dy) / len;
          return Math.abs(t * len - s) > h.width / 2 + 60;
        });
        for (let e = s + 100; e <= len - 80; e += 10) {
          const ok = okFrom && holesOf(w).every((h) => {
            const t = ((h.pc.x - w.p1.x) * dx + (h.pc.y - w.p1.y) * dy) / len;
            return Math.abs(t * len - e) > h.width / 2 + 60;
          });
          if (ok) {
            wallSeg = { wall: w.id, a: { x: w.p1.x + dx * s, y: w.p1.y + dy * s }, b: { x: w.p1.x + dx * e, y: w.p1.y + dy * e } };
            break;
          }
        }
        if (wallSeg) break;
      }
      if (wallSeg) break;
    }
    // между стенами: пара параллельных стен, точки на обращённых гранях
    let between: { a: P; b: P; w1: string; w2: string } | null = null;
    const faces = (w: any): [P, P, P, P] => {
      const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
      const dx = (w.p2.x - w.p1.x) / len, dy = (w.p2.y - w.p1.y) / len;
      const h = w.depth / 2;
      // левая грань: ось + нормаль (dy,-dx)*(-h)? нормаль (−dy,dx) — «лево» при Y вниз
      const nx = -dy, ny = dx;
      return [
        { x: w.p1.x + nx * h, y: w.p1.y + ny * h }, { x: w.p2.x + nx * h, y: w.p2.y + ny * h },
        { x: w.p1.x - nx * h, y: w.p1.y - ny * h }, { x: w.p2.x - nx * h, y: w.p2.y - ny * h },
      ];
    };
    outer2: for (const w1 of walls) {
      const l1 = Math.hypot(w1.p2.x - w1.p1.x, w1.p2.y - w1.p1.y);
      if (l1 < 150) continue;
      const f1 = faces(w1);
      const m1 = { x: (f1[0].x + f1[1].x) / 2, y: (f1[0].y + f1[1].y) / 2 };
      const m2 = { x: (f1[2].x + f1[3].x) / 2, y: (f1[2].y + f1[3].y) / 2 };
      for (const [fa, fb, side] of [[m1, f1, "n"], [m2, [f1[2], f1[3]], "s"]] as [P, P[], string][]) {
        for (const w2 of walls) {
          if (w2.id === w1.id) continue;
          // расстояние от fa до оси w2 (перпендикуляр к w1)
          const l2 = Math.hypot(w2.p2.x - w2.p1.x, w2.p2.y - w2.p1.y);
          const dx = (w2.p2.x - w2.p1.x) / l2, dy = (w2.p2.y - w2.p1.y) / l2;
          const d = Math.hypot(w2.p2.x - w2.p1.x, w2.p2.y - w2.p1.y);
          void d;
          // проекция fa на ось w2
          const t = ((fa.x - w2.p1.x) * dx + (fa.y - w2.p1.y) * dy);
          if (t < 60 || t > l2 - 60) continue;
          const proj = { x: w2.p1.x + dx * t, y: w2.p1.y + dy * t };
          const dist = Math.hypot(fa.x - proj.x, fa.y - proj.y);
          if (dist < 120 || dist > 500) continue;
          // перпендикулярность: ось w2 параллельна оси w1
          if (Math.abs(dx * (w1.p2.x - w1.p1.x) / l1 + dy * (w1.p2.y - w1.p1.y) / l1) < 0.999) continue;
          between = { a: fa, b: proj, w1: w1.id, w2: w2.id };
          break outer2;
        }
      }
    }
    // колонна: точка на верхней грани
    const pillar = pillars[0] ?? null;
    const pillarPt = pillar ? { x: pillar.pc.x, y: pillar.pc.y - pillar.h / 2 } : null;
    return { wallSeg, between, pillar, pillarPt, pillars };
  });
  await dump(page, "geo", geo);

  const st = await pickTool(page, "rigel");
  if (st !== "ok") throw new Error(`pickTool: ${st}`);

  const before = await copyServer(page);
  if (variant === "pillar" && geo.pillarPt) {
    await clickAt(page, geo.pillarPt);
  } else if (variant === "wall" && geo.wallSeg) {
    await dragAt(page, geo.wallSeg.a, geo.wallSeg.b);
  } else if (variant === "between" && geo.between) {
    await dragAt(page, geo.between.a, geo.between.b);
  } else if (variant === "free") {
    // свободный клик вдали от всего
    const m = await copyServer(page);
    void m;
    await clickAt(page, { x: 700, y: 300 });
  } else {
    throw new Error("нет геометрии");
  }
  await clearFog(page);
  const after = await copyServer(page);
  const diff = diffModels(before, after);
  await dump(page, "diff", { diff });
  const rig = await page.evaluate(() => {
    const m = (window as any).project.copy("server");
    return JSON.parse(JSON.stringify(m.rigels ?? {}));
  });
  await dump(page, "rigels", rig);
  await escape(page);
  await page.screenshot({ path: `../../screenshots/47-dbg2-${variant}.png` }).catch(() => {});
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
