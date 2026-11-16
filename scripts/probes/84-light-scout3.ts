// 84 (v3): можно ли кликнуть PRO-полосу в анонимном проекте (проба bypass is_pro), bra у стены.
import { launch, newAnonProject, buildBase, copyServer, switchSheet, clickAt, dragAt,
  diffModels, writeOut, escape } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await switchSheet(page, "light");

async function pickForce(key: string): Promise<"ok" | "missing"> {
  const st = await page.evaluate((k) => {
    const el: any = document.querySelector(`#plannertool_${k}`);
    if (!el) return "missing";
    const parent: any = el.closest(".subtools");
    if (parent && parent.id) document.querySelector(`[data-target="${parent.id}"]`)?.click();
    el.click();
    return "ok";
  }, key);
  await page.waitForTimeout(800);
  return st as "ok" | "missing";
}

const res: any = {};
// led_strip: drag в комнате
{
  const pick = await pickForce("led_strip");
  const b = await copyServer(page);
  await dragAt(page, { x: 120, y: -240 }, { x: 240, y: -240 });
  await escape(page);
  const a = await copyServer(page);
  res.led_strip = { pick, diff: diffModels(b, a) };
  console.log("led_strip", pick, JSON.stringify(Object.keys(res.led_strip.diff)));
}
// line_light: drag
{
  const pick = await pickForce("line_light");
  const b = await copyServer(page);
  await dragAt(page, { x: 120, y: -140 }, { x: 240, y: -140 });
  await escape(page);
  const a = await copyServer(page);
  res.line_light = { pick, diff: diffModels(b, a) };
  console.log("line_light", pick, JSON.stringify(Object.keys(res.line_light.diff)));
}
// recessed_strip: drag
{
  const pick = await pickForce("recessed_strip");
  const b = await copyServer(page);
  await dragAt(page, { x: 380, y: -240 }, { x: 500, y: -240 });
  await escape(page);
  const a = await copyServer(page);
  res.recessed_strip = { pick, diff: diffModels(b, a) };
  console.log("recessed_strip", pick, JSON.stringify(Object.keys(res.recessed_strip.diff)));
}
// bra у внутренней грани стены top (y=-290)
{
  const pick = await pickForce("bra");
  const b = await copyServer(page);
  await clickAt(page, { x: 200, y: -283 });
  await escape(page);
  const a = await copyServer(page);
  res.bra = { pick, diff: diffModels(b, a) };
  console.log("bra", pick, JSON.stringify(Object.keys(res.bra.diff)));
}
// панель свойств led_strip: правый клик по линии
const led = Object.values<any>(res.led_strip?.diff?.led_strips?.added ?? {})[0];
if (led) {
  await clickAt(page, { x: 180, y: -240 }, "right");
  const menus = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[id^=cm-]"))
      .filter((e: any) => e.offsetParent !== null)
      .map((e: any) => ({ id: e.id, rows: Array.from(e.querySelectorAll("li, .cm_item, input, select")).slice(0, 15).map((r: any) => ({ id: r.id, t: (r.textContent || r.value || "").trim().slice(0, 40) })) })));
  res.cm_led = menus;
  await escape(page);
}
writeOut("84-light-pro-ui", res);
await browser.close();
process.exit(0);
