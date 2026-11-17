// 113: проверка экранирования текста комментария copy("server") → restore в редакторе.
import { launch, newAnonProject, buildBase, writeOut, clearFog } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await clearFog(page);

const res = await page.evaluate(() => {
  const w: any = window as any;
  const c = w.COMMENTS.create({ x: 100, y: -100 });
  // закрываем меню и задаём текст прямо
  const inst = w.COMMENTS[c];
  inst.text = `it's "ok" \`bt\``;
  inst.draw();
  const ser = JSON.parse(JSON.stringify(w.COMMENTS.copy("server")));
  w.COMMENTS.restore(JSON.parse(JSON.stringify(ser)));
  const back = w.COMMENTS[Object.keys(ser)[0]]?.text;
  return { original: inst.text, serialized: ser[Object.keys(ser)[0]].text, restored: back };
});
writeOut("113-escape-check", res);
console.log(JSON.stringify(res, null, 1));
await browser.close();
process.exit(0);
