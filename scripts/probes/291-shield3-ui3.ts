// 291 (веха 1, проба 4): живой эталон шины и коллектора — события UI, дампы
// классов ShieldBus/ShieldCollector, каскад delete_module. БЕЗ сохранения:
// откат перезагрузкой; бэкап GET; гарды как в 291-shield3-scout.
// Запуск: node --experimental-strip-types scripts/probes/291-shield3-ui3.ts run
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadSession } from "../../src/session.ts";
import { cookieHeader } from "../../src/session.ts";
import { STATE_PATH, BASE_URL, HTTP_TIMEOUT_MS, USER_AGENT } from "../../src/config.ts";
import { loadModel, saveModel } from "../../src/api.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … " + process.argv[1] + " run (REMPLANNER_PROBE_* из env)");
  process.exit(0);
}
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
const READONLY_ID = process.env.REMPLANNER_PROBE_READONLY_ID;
const READONLY_PLAN_ID = process.env.REMPLANNER_PROBE_READONLY_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_*");
  process.exit(1);
}
if (OBJECT_ID === READONLY_ID) { console.error("OBJECT_ID === READONLY_ID — отказ до любой записи"); process.exit(1); }
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
const session = loadSession(STATE_PATH);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "ru-RU" });
await ctx.addCookies(session.cookies.map((c: any) => ({
  name: c.name, value: c.value, domain: c.domain, path: c.path ?? "/",
  expires: c.expires === -1 ? undefined : c.expires, httpOnly: c.httpOnly ?? false, secure: c.secure ?? false,
})));
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", String(e).slice(0, 200)));
await page.goto(`https://remplanner.ru/planner/?object_id=${OBJECT_ID}&plan_id=${PLAN_ID}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project && (window as any).project, null, { timeout: 60000 });
await page.waitForTimeout(3000);

const opened = await page.evaluate(() => ({ id: document.body?.dataset.objectId ?? null, planId: document.body?.dataset.plan_id ?? null }));
if (String(opened.id) !== String(OBJECT_ID) || String(opened.planId ?? "") !== String(PLAN_ID)) {
  console.error(`редактор открыл чужой план: ${JSON.stringify(opened)} — стоп`);
  await browser.close();
  process.exit(1);
}

const copyServer = () => page.evaluate(() => JSON.parse(JSON.stringify((window as any).project.copy("server"))));
const ownSig = (m: Record<string, unknown>): string => {
  const walls = Object.values((m["walls"] ?? {}) as Record<string, Record<string, unknown>>)
    .map((w) => [w["p1"] && (w["p1"] as any).x, w["p1"] && (w["p1"] as any).y, w["p2"] && (w["p2"] as any).x, w["p2"] && (w["p2"] as any).y, w["depth"], w["material"], w["role"] ?? ""].join(":"))
    .sort().join("|");
  const rooms = (m["rooms2"] ?? m["rooms1"] ?? {}) as Record<string, Record<string, unknown>>;
  const roomSig = Object.values(rooms).map((r) => JSON.stringify([((r["polygon"] ?? []) as any[]).map((p) => [p.x, p.y]), r["area"] ?? null])).sort().join("|");
  const colls = Object.keys(m).filter((k) => !["v", "id", "plan_id", "session", "borders", "rooms1", "logs", "is_forced", "params"].includes(k))
    .map((k) => `${k}=${Object.keys(m[k] ?? {}).length}`).sort().join(",");
  return `${walls}#${roomSig}#${colls}`;
};
const writeOut = (name: string, data: unknown) => writeFileSync(`${OUT}/${name}.json`, JSON.stringify(data, null, 1) + "\n");
// authkey объекта из ЛК (для A-транспорта восстановления бэкапа — как в 291-live-check)
const authKeyFor = async (session: ReturnType<typeof loadSession>, objectId: string): Promise<string> => {
  const res = await fetch(`${BASE_URL}/client/`, {
    headers: { cookie: cookieHeader(session, "remplanner.ru"), "user-agent": USER_AGENT, referer: `${BASE_URL}/client/` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const html = await res.text();
  const i = html.indexOf(`data-object="${objectId}"`);
  if (i < 0) throw new Error("в ЛК нет объекта dev-проекта (restore невозможен)");
  const m = /data-auth\S+="([0-9a-f]+)"/.exec(html.slice(i, i + 400));
  if (!m) throw new Error("в ЛК нет authkey для объекта (restore невозможен)");
  return m[1]!;
};
const clearFog = () => page.evaluate(() => {
  const f: any = document.querySelector("#planner_ui_message_fog");
  if (f && f.classList.contains("active") && !f.innerHTML.trim()) f.classList.remove("active");
  document.querySelectorAll(".planner_ui_message.active").forEach((e: any) => e.classList.remove("active"));
});
const switchSheet = async (sheet: string) => {
  await clearFog();
  const ok = await page.evaluate((s: string) => {
    const nav: any = document.querySelector(`.groups_navi_item.plan_${s}`);
    if (!nav) return false;
    nav.click();
    return true;
  }, sheet);
  if (!ok) throw new Error(`лист ${sheet} не найден`);
  await page.waitForTimeout(1500);
  await clearFog();
};
const toScreen = (p: { x: number; y: number }) => page.evaluate((pp: any) => {
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
const pickTool = async (key: string): Promise<string> => {
  const st = await page.evaluate((k: string) => {
    const el: any = document.querySelector(`#plannertool_${k}`);
    if (!el) return "missing";
    const group = el.closest(".tools_item, .subtools_item");
    if (el.classList.contains("is_pro") || (group && group.classList.contains("is_pro"))) return "pro";
    const parent: any = el.closest(".subtools");
    if (parent && parent.id) {
      const opener: any = document.querySelector(`[data-target="${parent.id}"]`);
      opener?.click();
    }
    el.click();
    return "ok";
  }, key);
  await page.waitForTimeout(600);
  return st;
};

let probeOk = false;
let restoreOk = false;
let backup: Awaited<ReturnType<typeof loadModel>> | null = null;
let readonlyBefore: Awaited<ReturnType<typeof loadModel>> | null = null;
try {
  backup = await loadModel(session, OBJECT_ID, PLAN_ID);
  writeFileSync(`${OUT}/backup-${OBJECT_ID}-291.json`, JSON.stringify({ _source: "GET, scripts/probes/291-shield3-ui3.ts, до прогона", model: backup.model }, null, 1));
  readonlyBefore = await loadModel(session, READONLY_ID, READONLY_PLAN_ID);
  if (readonlyBefore.data_empty === true) throw new Error("контрольный GET рабочего проекта пуст (data_empty) — стоп");
  console.log("backup ok");
  // гард «план в редакторе == сервер»: данные copy("server") сравниваются с GET-бэкапом
  // (не только id/plan_id из dataset) — до любой записи
  const openedCopy = await copyServer();
  if (ownSig(openedCopy) !== ownSig(backup.model)) {
    throw new Error('гард «план в редакторе == сервер» не прошёл (copy("server") vs GET) — стоп до любой записи');
  }
  console.log('гард «план в редакторе == сервер» (copy("server") vs GET): ОК');
  const get = backup.model as Record<string, unknown>;

  // 1. щиток-предмет
  const rooms = Object.values<any>(get.rooms2 ?? {});
  const room = rooms[0]!;
  const poly = (room.polygon ?? []).map((p: any) => ({ x: p.x, y: p.y }));
  const cx = poly.reduce((s: number, p: any) => s + p.x, 0) / poly.length;
  const cy = poly.reduce((s: number, p: any) => s + p.y, 0) / poly.length;
  await switchSheet("cables");
  if ((await pickTool("electric_shield")) !== "ok") throw new Error("щиток недоступен");
  await clickAt({ x: cx, y: cy });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const items = Object.values<any>((await copyServer()).items ?? {});
  const shieldItem = items.find((i: any) => i.name === "electric_shield");
  if (!shieldItem) throw new Error("щиток-предмет не появился");

  // 2. конструктор + 5 однотипных модулей (add_module(railId, type))
  await switchSheet("shield");
  await clickAt({ x: shieldItem.pc.x, y: shieldItem.pc.y });
  await page.waitForTimeout(800);
  const addModules = await page.evaluate((): { railId: string; modules: string[] } | "no instance" => {
    const w: any = window as any;
    const inst = Object.values<any>(w.SHIELDS ?? {})[0];
    if (!inst) return "no instance";
    const railId: string = Object.keys(inst.rails)[0]!;
    for (let i = 0; i < 5; i++) inst.add_module(railId, "shield_module");
    return { railId, modules: Object.keys(Object.values<any>(inst.rails)[0]!.modules) };
  });
  console.log("addModules:", JSON.stringify(addModules));

  // 3. шина: инструмент shield_busbar, mouseover по слоту → move → mousedown
  const pickBus = await pickTool("shield_busbar");
  console.log("pick shield_busbar:", pickBus);
  const slots = await page.evaluate(() => {
    const w: any = window as any;
    const inst = Object.values<any>(w.SHIELDS ?? {})[0];
    inst.init_bus_slots();
    return [...document.querySelectorAll(".bus-slot")].map((e: any) => {
      const r = e.getBoundingClientRect();
      return { type: e.getAttribute("data-slot-type"), x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
    });
  });
  console.log("bus slots:", JSON.stringify(slots));
  const top = slots.find((s) => s.type === "T");
  if (top) {
    await page.mouse.move(top.x - top.w / 2 + 5, top.y);
    await page.waitForTimeout(200);
    await page.mouse.move(top.x + 30, top.y, { steps: 10 });
    await page.waitForTimeout(200);
    await page.mouse.move(top.x, top.y, { steps: 6 });
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(800);
  }
  const afterBus = await copyServer();
  writeOut("293-after-bus", afterBus.shields);
  const shieldKey = Object.keys(afterBus.shields ?? {})[0] ?? "";
  console.log("bus:", JSON.stringify(afterBus.shields?.[shieldKey]?.buses ?? {}).slice(0, 500));

  // 4. коллектор: tool shield_collector; mousedown порта модуля0 → hover портами
  //    модулей 1..3 → mousedown порта модуля3 (карту строит port_mouseover)
  if ((await pickTool("shield_collector")) !== "ok") throw new Error("shield_collector недоступен");
  const portEls = await page.evaluate((): { id: string; x: number; y: number }[] => {
    const w: any = window as any;
    const inst = Object.values<any>(w.SHIELDS ?? {})[0];
    const mods = Object.values<any>(Object.values<any>(inst.rails)[0]!.modules).sort((a: any, b: any) => a.index - b.index);
    const out: { id: string; x: number; y: number }[] = [];
    for (const m of mods) {
      for (const p of m.ports) {
        const el: any = document.querySelector(`[data-id="${p.id}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          out.push({ id: p.id, x: r.x + r.width / 2, y: r.y + r.height / 2 });
        }
      }
      break; // порты первого модуля достаточно: каждый модуль рисует свои
    }
    if (out.length < 4) {
      // собрали только модуль 0 — соберём по всем модулям
      out.length = 0;
      for (const m of mods) {
        for (const p of m.ports) {
          const el: any = document.querySelector(`[data-id="${p.id}"]`);
          if (el) {
            const r = el.getBoundingClientRect();
            out.push({ id: p.id, x: r.x + r.width / 2, y: r.y + r.height / 2 });
          }
        }
      }
    }
    return out;
  });
  writeOut("293-port-els", portEls.slice(0, 24));
  console.log("port els:", portEls.length);
  const mods = await page.evaluate((): { id: string; index: number; ports: string[] }[] => {
    const w: any = window as any;
    const inst = Object.values<any>(w.SHIELDS ?? {})[0];
    return Object.values<any>(Object.values<any>(inst.rails)[0]!.modules).sort((a: any, b: any) => a.index - b.index).map((m: any) => ({ id: m.id, index: m.index, ports: m.ports.map((p: any) => p.id) }));
  });
  writeOut("293-mods", mods);
  const srcPort = portEls.find((p) => p.id === mods[0]!.ports[0]);
  const dstPort = portEls.find((p) => p.id === mods[3]!.ports[0]);
  console.log("src/dst:", srcPort, dstPort);
  if (srcPort && dstPort) {
    await page.mouse.move(srcPort.x, srcPort.y, { steps: 4 });
    await page.waitForTimeout(250);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(500);
    await page.mouse.move(dstPort.x, dstPort.y, { steps: 20 });
    await page.waitForTimeout(400);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(800);
  }
  const afterCol = await copyServer();
  writeOut("293-after-collector", afterCol.shields);
  console.log("collectors:", JSON.stringify(afterCol.shields?.[shieldKey]?.collectors ?? {}).slice(0, 700));
  await page.screenshot({ path: `${OUT}/293-bus-collector.png` });

  // 5. дампы классов
  const classes = await page.evaluate(() => {
    const w: any = window as any;
    const inst = Object.values<any>(w.SHIELDS ?? {})[0];
    const out: Record<string, string> = {};
    const rail0 = Object.values<any>(inst.rails)[0];
    const mod0 = Object.values<any>(rail0.modules)[0];
    const bus0 = Object.values<any>(inst.buses)[0];
    const col0 = Object.values<any>(inst.collectors)[0];
    const dump = (obj: any, name: string) => {
      if (!obj) return;
      out[`class:${name}`] = Function.prototype.toString.call(obj.constructor).slice(0, 14000);
      const seen = new Set<string>();
      let proto = obj;
      while (proto && proto !== Object.prototype) {
        for (const n of Object.getOwnPropertyNames(proto)) {
          if (seen.has(n)) continue;
          seen.add(n);
          try {
            if (typeof proto[n] === "function" && /calc|serialize|restore|position|width|port|remove|draw|validate/i.test(n)) {
              out[`${name}.${n}`] = Function.prototype.toString.call(proto[n]);
            }
          } catch { /* skip */ }
        }
        proto = Object.getPrototypeOf(proto);
      }
    };
    dump(mod0, "RailModule");
    dump(bus0, "ShieldBus");
    dump(col0, "ShieldCollector");
    for (const n of ["mousemove", "mouseover", "mousedown", "is_lower_row", "get_module_by_id", "get_module_slot", "bus_enter_ports", "delete_bus", "delete_collector", "validate_collectors", "get_collector_by_module_id", "module_port_click_collector", "module_port_click"]) {
      try {
        if (typeof inst[n] === "function") out[`Shield.${n}`] = Function.prototype.toString.call(inst[n]);
      } catch { /* skip */ }
    }
    return out;
  });
  writeOut("293-classes", classes);
  console.log("classes dumped:", Object.keys(classes).length);

  // 6. bus_enter_ports 6→8→6
  const portsExp = await page.evaluate(() => {
    const w: any = window as any;
    const inst = Object.values<any>(w.SHIELDS ?? {})[0];
    const busId = Object.keys(inst.buses)[0];
    if (!busId) return "no bus";
    inst.bus_enter_ports(busId, 8);
    const n8 = inst.buses[busId].ports.length;
    inst.bus_enter_ports(busId, 6);
    return { n8, n6: inst.buses[busId].ports.length, distance: inst.buses[busId].distance, type: inst.buses[busId].type };
  });
  console.log("bus ports exp:", JSON.stringify(portsExp));
  writeOut("293-bus-ports-exp", portsExp);

  // 7. каскад: удаление модуля коллектора
  const cascade = await page.evaluate(() => {
    const w: any = window as any;
    const inst = Object.values<any>(w.SHIELDS ?? {})[0];
    const col = Object.values<any>(inst.collectors)[0];
    if (!col) return "no collector";
    const mid = Object.keys(col.modules)[0];
    inst.delete_module(mid);
    return { deletedModule: mid, collectorsLeft: Object.keys(inst.collectors).length, wiresLeft: Object.keys(inst.wires).length };
  });
  console.log("cascade:", JSON.stringify(cascade));
  writeOut("293-cascade", cascade);
  writeOut("293-after-cascade", (await copyServer()).shields);

  const roAfter = await loadModel(session, READONLY_ID, READONLY_PLAN_ID);
  const sameRo = roAfter.save_id === readonlyBefore.save_id && ownSig(roAfter.model) === ownSig(readonlyBefore.model);
  console.log(sameRo ? "READONLY OK" : "READONLY CHANGED — СТОП");
  probeOk = sameRo;
} catch (e) {
  console.error("PROBE_ERROR:", (e as Error).message);
  probeOk = false;
} finally {
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (window as any).WALLS && (window as any).$Project, null, { timeout: 60000 });
    await page.waitForTimeout(3000);
    if (backup) {
      const after = await loadModel(session, OBJECT_ID, PLAN_ID);
      const same = ownSig(after.model) === ownSig(backup.model);
      if (same) {
        console.log("GET после перезагрузки: не изменился (откат ОК)");
        restoreOk = true;
      } else {
        // ревью 293 №4(в): при расхождении сигнатуры бэкап возвращается
        // A-транспортом (как в 291-live-check), а не только фиксируется в отчёте
        console.log("GET после перезагрузки: ИЗМЕНИЛСЯ — возврат бэкапа");
        const fresh = await loadModel(session, OBJECT_ID, PLAN_ID);
        const sv = await saveModel(session, {
          objectId: OBJECT_ID,
          planId: PLAN_ID,
          authkey: await authKeyFor(session, OBJECT_ID),
          saveId: fresh.save_id,
          model: backup.model,
        });
        console.log("finally: бэкап возвращён (A-транспорт), ok:", sv.ok, "conflict:", sv.conflict);
        const restored = await loadModel(session, OBJECT_ID, PLAN_ID);
        restoreOk = ownSig(restored.model) === ownSig(backup.model);
        console.log("finally: сверка сигнатуры после восстановления:", restoreOk ? "OK" : "MISMATCH");
      }
    }
  } catch (e) {
    console.error("ROLLBACK_ERROR:", (e as Error).message.slice(0, 300));
    restoreOk = false;
  }
  await browser.close().catch(() => {});
}
process.exit(probeOk && restoreOk ? 0 : 1);
