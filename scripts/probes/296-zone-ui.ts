// 296: живой съём эталонов зонирования (этап 296) в dev-проекте БЕЗ записи на сервер:
// drag zone_floor / zone_hydroisolation / zone_floor_cap на своих листах и
// zone_ceiling с концом на грани потолочной закладной (закладная создаётся кликами UI).
// Локальное состояние редактора откатывается перезагрузкой страницы; серверный GET
// сверяется с бэкапом до/после. Гарды (ревью 285 №3): ID только из env, OBJECT_ID !=
// READONLY_ID, план в редакторе == серверу, контрольный GET по реальному plan_id
// (непустой), finally с browser.close, восстановление. node scripts/probes/296-zone-ui.ts run
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { loadModel, type LoadedModel } from "../../src/api.ts";

if (process.argv[2] !== "run") { console.error("запуск: run (ID из env)"); process.exit(0); }
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID/PLAN_ID/READONLY_ID/READONLY_PLAN_ID");
  process.exit(1);
}
if (OBJECT_ID === READONLY_ID) { console.error("OBJECT_ID == READONLY_ID — стоп"); process.exit(1); }
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 9 * 60_000).unref();

const session = { ...loadSession(STATE_PATH), account: true } as const;
const strip = (m: unknown) => {
  const c = structuredClone(m as Record<string, unknown>);
  for (const k of ["save_id", "session", "log_plan", "version", "errors", "logs", "final", "drawing", "params"]) delete c[k];
  return JSON.stringify(c);
};
const roSnap = async (tag: string): Promise<LoadedModel> => {
  const m = await loadModel(session, READONLY_ID, READONLY_PLAN_ID);
  if (m.data_empty) throw new Error(`контрольный GET ${tag} пустой (data_empty) — отказ`);
  writeFileSync(`.orca-reports/tmp/296-get-readonly-${tag}.json`, JSON.stringify(m, null, 1));
  return m;
};

const roBefore = await roSnap("before");
const beforeModel = await loadModel(session, OBJECT_ID, PLAN_ID);
const backupPath = `.orca-reports/backup-${OBJECT_ID}-296.json`;
if (!existsSync(backupPath)) {
  writeFileSync(backupPath, JSON.stringify(beforeModel, null, 1) + "\n");
  console.log("бэкап:", backupPath);
  } else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: unknown };
    if (strip(stored.model) !== strip(beforeModel.model)) {
      throw new Error("модель на сервере не совпадает с бэкапом — стоп");
    }
    console.log("бэкап существует; сверка с текущим GET: совпадает");
  }

const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
const page = editor.page;
let devUnchanged = false;
try {
  const planInEditor = await page.evaluate(() => String((window as any).project?.copy("server")?.plan_id ?? ""));
  if (planInEditor !== String(beforeModel.plan_id)) {
    // throw, а не process.exit: finally обязан закрыть браузер (ревью 298 №9а)
    throw new Error(`план в редакторе ${planInEditor} != серверу ${beforeModel.plan_id}`);
  }
  const log = (...a: unknown[]) => console.log(...a);
  await page.evaluate(() => {
    const w: any = window as any;
    w.__trace = [];
    const t = (m: string) => w.__trace.push(m);
    if (w.warning?.show) {
      const orig = w.warning.show.bind(w.warning);
      w.warning.show = (ty: string, m: string) => { t(`WARN ${ty}: ${m}`); return orig(ty, m); };
    }
  });
  // перечень пунктов навигации и инструментов зон на каждом листе (разведка)
  const nav = await page.evaluate(() => Array.from(document.querySelectorAll("[class*=groups_navi_item]")).map((e: any) => e.className).slice(0, 40));
  log("nav:", JSON.stringify(nav));
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
  const drag = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
    await clearFog();
    const s = await toScreen(a), e = await toScreen(b);
    await page.mouse.move(s.x, s.y, { steps: 5 });
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.waitForTimeout(200);
    await page.mouse.move(e.x, e.y, { steps: 15 });
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForTimeout(900);
  };
  const trace = async (tag: string) => {
    const tr: string[] = await page.evaluate(() => (window as any).__trace.splice(0));
    log(tag, JSON.stringify(tr));
  };
  // выбор комнаты: прямоугольная, минимум 2 внешних ребра, без ригелей/закладных
  const model0: any = await page.evaluate(() => (window as any).project.copy("server"));
  const isOverPoly = (pt: { x: number; y: number }, poly: Array<{ x: number; y: number }>) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i]!.x, yi = poly[i]!.y, xj = poly[j]!.x, yj = poly[j]!.y;
      if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  const rooms = Object.entries<any>(model0.rooms2 ?? {});
  type ExtEdge = { p1: { x: number; y: number }; p2: { x: number; y: number }; inPt: { x: number; y: number } };
  let room: { rid: string; poly: Array<{ x: number; y: number }>; edges: Array<{ p1: { x: number; y: number }; p2: { x: number; y: number } }>; external: ExtEdge[] } | null = null;
  for (const [rid, r] of rooms) {
    const poly: Array<{ x: number; y: number }> = r.polygon;
    if (poly.length !== 4) continue;
    if (Object.keys(r.rigels ?? {}).length > 0) continue;
    const inPt = (mx: number, my: number, len: number, ax: number, ay: number, bx: number, by: number) => {
      const nx = (by - ay) / len, ny = -(bx - ax) / len;
      return isOverPoly({ x: mx + nx * 5, y: my + ny * 5 }, poly) ? { x: mx + nx * 5, y: my + ny * 5 } : { x: mx - nx * 5, y: my - ny * 5 };
    };
    const external: ExtEdge[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 200) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      let neighbor = false;
      for (const [, other] of rooms) {
        if (other === r) continue;
        const o = inPt(mx, my, len, a.x, a.y, b.x, b.y);
        if (isOverPoly({ x: 2 * mx - o.x, y: 2 * my - o.y }, (other as any).polygon)) { neighbor = true; break; }
      }
      if (!neighbor) external.push({ p1: a, p2: b, inPt: inPt(mx, my, len, a.x, a.y, b.x, b.y) });
    }
    if (external.length >= 2) { room = { rid, poly, edges: external.map((e) => ({ p1: e.p1, p2: e.p2 })), external }; break; }
  }
  if (!room) throw new Error("нет подходящей комнаты");
  const ext: ExtEdge[] = room.external;
  log("комната:", room.rid, "внешних рёбер:", ext.length);
  const closeTo = (pt: { x: number; y: number }, d: number): { x: number; y: number } => {
    // точка на ребре в d см от inPt внутрь ребра — для магнита 15 см не нужна точность
    return pt;
  };
  void closeTo;
  // линии строим между точками чуть отступив от середины рёбер, чтобы магнит сработал
  const shift = (p: { x: number; y: number }, poly: Array<{ x: number; y: number }>): { x: number; y: number } => {
    // сдвигаем к центру комнаты на 1 см — внутри, магнит подберёт ребро
    const cx = poly.reduce((s, q) => s + q.x, 0) / poly.length, cy = poly.reduce((s, q) => s + q.y, 0) / poly.length;
    const l = Math.hypot(cx - p.x, cy - p.y) || 1;
    return { x: p.x + ((cx - p.x) / l) * 3, y: p.y + ((cy - p.y) / l) * 3 };
  };
  const snapZones = async (tag: string) => {
    const data = await page.evaluate(() => {
      const w: any = window as any;
      const m: any = w.project.copy("server");
      const zds: any = w.ZONE_DELIMITERS ?? {};
      return {
        runtime: Object.fromEntries(Object.entries<any>(zds).map(([k, v]: any) => [k, v.serialize ? v.serialize() : v])),
        top: m.zone_delimiters ?? null,
        roomsZoneCounts: Object.fromEntries(Object.entries<any>(m.rooms2 ?? {}).map(([k, r]: any) => [k, {
          zones: (r.zones ?? []).length, floors: (r.floors ?? []).length, ceilings: (r.ceilings ?? []).length,
          hydroisolations: (r.hydroisolations ?? []).length, caps: (r.caps ?? []).length, delimiters: Object.keys(r.delimiters ?? {}).length, rigels: Object.keys(r.rigels ?? {}).length,
        }])),
      };
    });
    writeFileSync(`.orca-reports/tmp/296-${tag}.json`, JSON.stringify(data, null, 1));
    return data;
  };
  const clickNav = async (planClass: string, toolId: string): Promise<boolean> => {
    await page.evaluate((pc) => {
      const el: any = document.querySelector(`.groups_navi_item.plan_${pc}`) ?? Array.from(document.querySelectorAll(".groups_navi_item")).find((e: any) => String(e.className).includes(`plan_${pc}`));
      if (el) el.click();
    }, planClass);
    await page.waitForTimeout(2000);
    // кликаем кнопку только если она видима (панели всех листов остаются в DOM);
    // видимость появляется с анимацией — до 3 попыток
    for (let attempt = 0; attempt < 3; attempt++) {
      const okTool = await page.evaluate((tid) => {
        const el: any = document.querySelector(`#${tid}`);
        if (el && (el as any).offsetParent !== null) { el.click(); return true; }
        return false;
      }, toolId);
      if (okTool) {
        await page.waitForTimeout(600);
        return true;
      }
      await page.waitForTimeout(1000);
    }
    const visible = await page.evaluate(() => Array.from(document.querySelectorAll("[id^=plannertool_]")).filter((e: any) => e.offsetParent !== null).map((e: any) => e.id));
    log(`видимые инструменты на листе ${planClass}:`, JSON.stringify(visible));
    return false;
  };
  const results: Record<string, unknown> = {};
  const baseline = await snapZones("baseline");
  results.baselineTopKeys = Object.keys((baseline as any).runtime ?? {});

  // 1. zone_floor (лист «Напольные покрытия»)
  const e1 = shift(ext[0]!.inPt, room!.poly), e2 = shift(ext[1]!.inPt, room!.poly);
  results.floorTool = await clickNav("floor", "plannertool_zone_floor");
  if (!results.floorTool) {
    results.floorTool = await page.evaluate(() => {
      const el: any = Array.from(document.querySelectorAll("[id^=plannertool_]")).find((e: any) => e.offsetParent !== null && String(e.id).includes("zone"));
      if (el) { el.click(); return el.id; }
      return null;
    });
    await page.waitForTimeout(600);
  }
  results.floorSheetTools = await page.evaluate(() => Array.from(document.querySelectorAll("[id^=plannertool_]")).filter((e: any) => e.offsetParent !== null).map((e: any) => e.id));
  await drag(e1, e2);
  await trace("296 floor:");
  results.floor = await snapZones("floor");
  // короткая линия (~6 см) между точками двух смежных рёбер у общего угла —
  // есть ли у редактора минимальная длина
  const corner = ext[0]!.p1;
  const along = (edgeP1: { x: number; y: number }, edgeP2: { x: number; y: number }, d: number) => {
    const l = Math.hypot(edgeP2.x - edgeP1.x, edgeP2.y - edgeP1.y) || 1;
    return { x: edgeP1.x + ((edgeP2.x - edgeP1.x) / l) * d, y: edgeP1.y + ((edgeP2.y - edgeP1.y) / l) * d };
  };
  const s1 = along(ext[0]!.p1, ext[0]!.p2, 8), s2 = along(ext[1]!.p1, ext[1]!.p2, 8);
  results.floorTool2 = results.floorTool;
  if (results.floorTool) {
    await drag(s1, s2);
    await trace("296 floor short:");
    results.floorShort = await snapZones("floor-short");
  }

  // 2. zone_hydroisolation («Гидроизоляция»)
  results.hydroTool = await clickNav("hydroisolation", "plannertool_zone_hydroisolation");
  if (!results.hydroTool) {
    results.hydroTool = await page.evaluate(() => {
      const el: any = Array.from(document.querySelectorAll("[id^=plannertool_]")).find((e: any) => e.offsetParent !== null && String(e.id).includes("zone"));
      if (el) { el.click(); return el.id; }
      return null;
    });
    await page.waitForTimeout(600);
  }
  results.hydroSheetTools = await page.evaluate(() => Array.from(document.querySelectorAll("[id^=plannertool_]")).filter((e: any) => e.offsetParent !== null).map((e: any) => e.id));
  if (results.hydroTool) {
    await drag(e1, e2);
    await trace("296 hydro:");
    results.hydro = await snapZones("hydro");
  }

  // 3. zone_floor_cap («Стяжка»; пункт навигации plan_styazhka)
  results.capTool = await clickNav("styazhka", "plannertool_zone_floor_cap");
  if (!results.capTool) {
    results.capTool = await page.evaluate(() => {
      const el: any = Array.from(document.querySelectorAll("[id^=plannertool_]")).find((e: any) => e.offsetParent !== null && String(e.id).includes("zone"));
      if (el) { el.click(); return el.id; }
      return null;
    });
    await page.waitForTimeout(600);
  }
  results.capSheetTools = await page.evaluate(() => Array.from(document.querySelectorAll("[id^=plannertool_]")).filter((e: any) => e.offsetParent !== null).map((e: any) => e.id));
  if (results.capTool) {
    await drag(e1, e2);
    await trace("296 cap:");
    results.cap = await snapZones("cap");
  }

  // 4. потолочная закладная (ceiling_rigel) + разделитель с концом на её грани
  results.ceilTool = await clickNav("ceiling", "plannertool_ceiling_rigel");
  results.toolGlobal = await page.evaluate(() => ({ tool: (window as any).tool, mode: (window as any).CURSOR?.mode ?? null }));
  // закладная «от стены до стены»: чуть внутри от середин рёбер 0 и 2
  const a0 = room!.edges[0]!, a2 = room!.edges[2] ?? room!.edges[1]!;
  const midOf = (e: { p1: { x: number; y: number }; p2: { x: number; y: number } }) => ({ x: (e.p1.x + e.p2.x) / 2, y: (e.p1.y + e.p2.y) / 2 });
  const m0 = midOf(a0), m2 = midOf(a2);
  const cxd = room!.poly.reduce((s, q) => s + q.x, 0) / room!.poly.length, cyd = room!.poly.reduce((s, q) => s + q.y, 0) / room!.poly.length;
  const toward = (p: { x: number; y: number }, d: number) => {
    const l = Math.hypot(cxd - p.x, cyd - p.y) || 1;
    return { x: p.x + ((cxd - p.x) / l) * d, y: p.y + ((cyd - p.y) / l) * d };
  };
  const rgA = toward(m0, 2), rgB = toward(m2, 2);
  await drag(rgA, rgB);
  await trace("296 rigel:");
  results.rigelRuntime = await page.evaluate((rid) => {
    const w: any = window as any;
    return {
      tool: w.tool,
      roomRigelsRuntime: w.ROOMS2?.[rid]?.rigels ?? null,
      roomRigelsCopy: w.project.copy("server").rooms2?.[rid]?.rigels ?? null,
    };
  }, room!.rid);
  const rigelRuntime = (results.rigelRuntime as { roomRigelsRuntime?: Record<string, { p1?: { x: number; y: number }; p2?: { x: number; y: number }; width?: number }> }).roomRigelsRuntime ?? {};
  results.rigel = rigelRuntime;
  // разделитель: от ребра 3 (перпендикулярного закладной) к грани закладной
  // (линия от ребра 2 шла поперёк полосы — «не пересекайте закладные»)
  const e3 = shift(ext[3] ? ext[3].inPt : ext[1]!.inPt, room!.poly);
  // точка чуть внутри от грани закладной: грань = ближайшее к e3 ребро полигона закладной
  const rigelRec = Object.values<any>(results.rigel ?? {})[0];
  let rigelFace: { x: number; y: number } | null = null;
  if (rigelRec && rigelRec.p1 && rigelRec.p2) {
    const p1 = rigelRec.p1, p2 = rigelRec.p2, wdt = Number(rigelRec.width ?? 10) / 2;
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const nx = -(p2.y - p1.y) / len, ny = (p2.x - p1.x) / len;
    const faces = [
      { p1: { x: p1.x + nx * wdt, y: p1.y + ny * wdt }, p2: { x: p2.x + nx * wdt, y: p2.y + ny * wdt } },
      { p1: { x: p1.x - nx * wdt, y: p1.y - ny * wdt }, p2: { x: p2.x - nx * wdt, y: p2.y - ny * wdt } },
    ];
    const distToSeg = (pt: { x: number; y: number }, s: { p1: { x: number; y: number }; p2: { x: number; y: number } }) => {
      const vx = s.p2.x - s.p1.x, vy = s.p2.y - s.p1.y;
      const l2 = vx * vx + vy * vy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - s.p1.x) * vx + (pt.y - s.p1.y) * vy) / l2));
      return Math.hypot(pt.x - (s.p1.x + t * vx), pt.y - (s.p1.y + t * vy));
    };
    const face = faces.sort((f, g) => distToSeg(e3, f) - distToSeg(e3, g))[0]!;
    rigelFace = { x: (face.p1.x + face.p2.x) / 2, y: (face.p1.y + face.p2.y) / 2 };
  }
  results.ceilZoneTool = await clickNav("ceiling", "plannertool_zone_ceiling");
  if (rigelFace) {
    // конечная точка: на грани закладной, чуть сдвинута внутрь грани (магнит 100 мм)
    await drag(e3, rigelFace);
    await trace("296 ceilzone→rigel:");
    results.ceilzoneRigel = await snapZones("ceilzone-rigel");
  } else {
    log("FAIL: закладная не создалась");
  }

  // сериализованные закладные + зоны потолка: единый дамп
  const dump = await page.evaluate(() => {
    const w: any = window as any;
    const m: any = w.project.copy("server");
    return {
      zone_delimiters_runtime: Object.fromEntries(Object.entries<any>(w.ZONE_DELIMITERS ?? {}).map(([k, v]: any) => [k, v.serialize ? v.serialize() : v])),
      zone_delimiters_top: m.zone_delimiters ?? {},
      rooms2_zone_bearing: Object.fromEntries(Object.entries<any>(m.rooms2 ?? {}).filter(([, r]: any) => (r.rigels && Object.keys(r.rigels).length) || (r.delimiters && Object.keys(r.delimiters).length)).map(([k, r]: any) => [k, { rigels: r.rigels, delimiters: r.delimiters }])),
    };
  });
  writeFileSync(".orca-reports/tmp/296-ui-etalons-raw.json", JSON.stringify(results, null, 1));
  writeFileSync(".orca-reports/tmp/296-ui-etalons-model.json", JSON.stringify(dump, null, 1));
  log("дампы записаны");
  // откат локального состояния
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 900));
  process.exitCode = 1;
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
const after = await loadModel(session, OBJECT_ID, PLAN_ID);
devUnchanged = strip(after.model) === strip(beforeModel.model);
console.log("GET dev после пробы == бэкап:", devUnchanged ? "OK — не изменился" : "РАСХОЖДЕНИЕ");
const roAfter = await roSnap("after");
const roUnchanged = strip(roAfter.model) === strip(roBefore.model) && roAfter.save_id === roBefore.save_id;
console.log("контрольный проект:", roUnchanged ? "не изменился (канон + save_id)" : "ИЗМЕНИЛСЯ — СТОП");
// ревью 298 №9б: расхождение = код 1, а не тихий exit(0)
if (!devUnchanged) process.exitCode = 1;
if (!roUnchanged) process.exitCode = 1;
process.exit(process.exitCode ?? 0);
