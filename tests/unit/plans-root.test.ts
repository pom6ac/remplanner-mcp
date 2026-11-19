// 213 plans-root (аудит 65 B3, решение пользователя): политика корневого каталога
// import/export — пути tools project_export_plan/project_import_plan относительно
// корня <home>/plans (REMPLANNER_HOME/plans в тестах). Отказ при выходе за корень,
// symlink в компонентах пути, не-.plan расширении; позитивные сценарии и roundtrip.
// Офлайн: сеть не используется, состояние — во временном HOME (helpers/tmp-home).
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync, renameSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { assertDirStillInside, fsCheckCalls, readPlanFile, resolvePlanPath } from "../../src/server/tools-projects.ts";
import { fsWriteCalls } from "../../src/fs-safe.ts";
import { HOME_DIR, PLANS_DIR } from "../../src/config.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests/fixtures/anon-rect-4000x3000.json");

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as ToolCallResult).content as { text: string }[])[0]!.text;
const parsed = (r: unknown): Record<string, unknown> => JSON.parse(text(r)) as Record<string, unknown>;

async function start(): Promise<Client> {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const server = buildServer(ctx);
  const client = new Client({ name: "plans-root", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

/** Вызов инструмента, который обязан вернуть структурированную ошибку. */
async function callError(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ code: string; message: string }> {
  const r = await client.callTool({ name, arguments: args });
  assert.ok((r as ToolCallResult).isError, `${name}: ожидалась ошибка`);
  return JSON.parse(text(r)) as { code: string; message: string };
}

const mode = (p: string): number => statSync(p).mode & 0o777;
const inside = (p: string): boolean => p.startsWith(PLANS_DIR + "/");

test("plans-root: export по относительному пути — файл в корне plans (0600, каталог 0700), ответ с path и relative_path", async () => {
  const client = await start();
  try {
    const res = parsed(await client.callTool({ name: "project_export_plan", arguments: { path: "kitchen.plan" } }));
    assert.equal(res["relative_path"], "kitchen.plan");
    assert.ok(typeof res["path"] === "string" && inside(res["path"] as string), "path — абсолютный внутри plans");
    assert.equal(res["path"], join(PLANS_DIR, "kitchen.plan"));
    assert.ok(existsSync(join(PLANS_DIR, "kitchen.plan")));
    assert.equal(mode(PLANS_DIR), 0o700, "корень plans 0700");
    assert.equal(mode(join(PLANS_DIR, "kitchen.plan")), 0o600, "файл плана 0600");
  } finally {
    await client.close();
  }
});

test("plans-root: export в подкаталог — каталог создаётся внутри корня с 0700", async () => {
  const client = await start();
  try {
    const res = parsed(await client.callTool({ name: "project_export_plan", arguments: { path: "2026/kitchen.plan" } }));
    assert.equal(res["relative_path"], "2026/kitchen.plan");
    assert.ok(existsSync(join(PLANS_DIR, "2026", "kitchen.plan")));
    assert.equal(mode(join(PLANS_DIR, "2026")), 0o700);
  } finally {
    await client.close();
  }
});

test("plans-root: абсолютный путь внутри корня принимается", async () => {
  const client = await start();
  try {
    const abs = join(PLANS_DIR, "abs.plan");
    const res = parsed(await client.callTool({ name: "project_export_plan", arguments: { path: abs } }));
    assert.equal(res["path"], abs);
    assert.equal(res["relative_path"], "abs.plan");
    assert.ok(existsSync(abs));
  } finally {
    await client.close();
  }
});

test("plans-root: roundtrip export → import, imported с path и relative_path", async () => {
  const client = await start();
  try {
    await client.callTool({ name: "project_export_plan", arguments: { path: "roundtrip.plan" } });
    // правим модель, чтобы импорт что-то заменял
    await client.callTool({ name: "project_clear", arguments: { confirm: true } });
    const res = parsed(await client.callTool({ name: "project_import_plan", arguments: { path: "roundtrip.plan", replace: true } }));
    assert.equal(res["relative_path"], "roundtrip.plan");
    assert.ok(typeof res["imported"] === "string" && inside(res["imported"] as string), "imported — абсолютный внутри plans");
    assert.equal(res["imported"], join(PLANS_DIR, "roundtrip.plan"));
    assert.ok(Number(res["walls"]) > 0, "стены импортированы");
  } finally {
    await client.close();
  }
});

test("plans-root: ../x.plan отклонён, файл вне корня не создан", async () => {
  const client = await start();
  try {
    const err = await callError(client, "project_export_plan", { path: "../x.plan" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /корень/);
    assert.ok(!existsSync(join(HOME_DIR, "x.plan")), "файл вне корня не создан");
  } finally {
    await client.close();
  }
});

test("plans-root: абсолютный путь вне корня отклонён, файл не создан", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-outside-"));
  try {
    const outside = join(outsideDir, "x.plan");
    const err = await callError(client, "project_export_plan", { path: outside });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.ok(!existsSync(outside), "файл вне корня не создан");
  } finally {
    await client.close();
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("plans-root: a/../../x.plan отклонён, файл вне корня не создан", async () => {
  const client = await start();
  try {
    const err = await callError(client, "project_export_plan", { path: "a/../../x.plan" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.ok(!existsSync(join(HOME_DIR, "x.plan")), "файл вне корня не создан");
    assert.ok(!existsSync(join(PLANS_DIR, "a")), "промежуточный каталог не создан");
  } finally {
    await client.close();
  }
});

test("plans-root: import ../out.plan отклонён до чтения, файл вне корня не читается и не меняется", async () => {
  const client = await start();
  try {
    const outside = join(HOME_DIR, "out.plan");
    writeFileSync(outside, '{"walls":{}}');
    const before = readFileSync(outside, "utf8");
    const err = await callError(client, "project_import_plan", { path: "../out.plan", replace: true });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /корень/);
    assert.equal(readFileSync(outside, "utf8"), before, "файл вне корня не тронут");
  } finally {
    await client.close();
  }
});

test("plans-root: symlink-каталог внутри корня, указывающий наружу, отклонён; цель ссылки не тронута", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-link-out-"));
  try {
    symlinkSync(outsideDir, join(PLANS_DIR, "link"));
    const err = await callError(client, "project_export_plan", { path: "link/x.plan" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /символическую ссылку/);
    assert.deepEqual(readdirSync(outsideDir), [], "в цель ссылки ничего не записано");
    // и import через symlink-каталог отклонён
    const err2 = await callError(client, "project_import_plan", { path: "link/x.plan", replace: true });
    assert.equal(err2.code, "INVALID_ARGUMENT");
  } finally {
    await client.close();
    rmSync(join(PLANS_DIR, "link"), { force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("plans-root: symlink-файл внутри корня отклонён (export и import), цель ссылки не тронута", async () => {
  const client = await start();
  try {
    const real = join(PLANS_DIR, "real.plan");
    writeFileSync(real, '{"walls":{}}');
    const link = join(PLANS_DIR, "link.plan");
    symlinkSync(real, link);
    const err = await callError(client, "project_export_plan", { path: "link.plan" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /символическую ссылку/);
    const err2 = await callError(client, "project_import_plan", { path: "link.plan", replace: true });
    assert.equal(err2.code, "INVALID_ARGUMENT");
    assert.equal(readFileSync(real, "utf8"), '{"walls":{}}', "цель ссылки не перезаписана");
    assert.ok(lstatSync(link).isSymbolicLink(), "ссылка не заменена файлом");
  } finally {
    await client.close();
  }
});

test("plans-root: расширение не .plan отклонено, файл не создан", async () => {
  const client = await start();
  try {
    const err = await callError(client, "project_export_plan", { path: "kitchen.json" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /\.plan/);
    const err2 = await callError(client, "project_import_plan", { path: "kitchen.json", replace: true });
    assert.equal(err2.code, "INVALID_ARGUMENT");
    assert.ok(!existsSync(join(PLANS_DIR, "kitchen.json")), "файл не создан");
  } finally {
    await client.close();
  }
});

// ---------- resolvePlanPath: точечные случаи ----------

test("plans-root: resolvePlanPath — пустое имя и имя без файла (.plan) отклонены", () => {
  assert.throws(() => resolvePlanPath(""), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => resolvePlanPath("   "), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => resolvePlanPath(".plan"), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => resolvePlanPath("2026/.plan"), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
});

test("plans-root: resolvePlanPath — несуществующий хвост не мешает, существующие компоненты без symlink проходят", () => {
  const res = resolvePlanPath("deep/nested/x.plan");
  assert.equal(res.relative, "deep/nested/x.plan");
  assert.equal(res.absolute, join(PLANS_DIR, "deep", "nested", "x.plan"));
  rmSync(join(PLANS_DIR, "deep"), { recursive: true, force: true });
  assert.ok(!existsSync(join(PLANS_DIR, "deep")));
});

test("plans-root: resolvePlanPath сам корень plans создаёт с 0700 при первом использовании", () => {
  rmSync(PLANS_DIR, { recursive: true, force: true });
  assert.ok(!existsSync(PLANS_DIR));
  mkdirSync(HOME_DIR, { recursive: true });
  resolvePlanPath("boot.plan");
  assert.ok(existsSync(PLANS_DIR));
  assert.equal(mode(PLANS_DIR), 0o700);
});

// ---------- ревью 214: major №1 и minor №2–№8 ----------

// №1 (major): корень plans — symlink → отказ ДО любых побочных эффектов:
// ни chmod, ни mkdir не выполняются, внешний каталог не меняется.
test("plans-root: корень plans — symlink на внешний каталог → отказ, внешний каталог не изменён", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-root-sym-"));
  const bak = PLANS_DIR + ".bak";
  try {
    writeFileSync(join(outsideDir, "keep.txt"), "keep");
    chmodSync(outsideDir, 0o755);
    mkdirSync(PLANS_DIR, { recursive: true });
    renameSync(PLANS_DIR, bak);
    symlinkSync(outsideDir, PLANS_DIR);
    // (а) запрос с выходом за корень: отказ, chmod по ссылке не выполняется
    const err = await callError(client, "project_export_plan", { path: "../y.plan" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /символическая ссылка/);
    // (б) и обычное имя тоже отклонено: корень-ссылка не принимается вовсе
    const err2 = await callError(client, "project_export_plan", { path: "x.plan" });
    assert.equal(err2.code, "INVALID_ARGUMENT");
    assert.equal(statSync(outsideDir).mode & 0o777, 0o755, "права внешнего каталога не изменились");
    assert.deepEqual(readdirSync(outsideDir), ["keep.txt"], "содержимое внешнего каталога не изменилось");
    assert.ok(!existsSync(join(outsideDir, "y.plan")), "файл не создан во внешнем каталоге");
    assert.ok(!existsSync(join(outsideDir, "x.plan")), "файл не создан во внешнем каталоге");
  } finally {
    await client.close();
    rmSync(PLANS_DIR, { force: true });
    if (existsSync(bak)) renameSync(bak, PLANS_DIR);
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// №11 (ревью 216, решение координатора): каталог состояния приложения МОЖЕТ быть
// symlink (настройка пользователя, как для backups/renders на d714539); корень
// plans считается от реального пути, export/import работают внутри цели/plans
test("plans-root: каталог состояния приложения (HOME) — symlink допустим, export/import внутри цели/plans", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-home-sym-"));
  const bak = HOME_DIR + ".bak";
  try {
    writeFileSync(join(outsideDir, "keep.txt"), "keep");
    chmodSync(outsideDir, 0o755);
    renameSync(HOME_DIR, bak);
    symlinkSync(outsideDir, HOME_DIR);
    // export проходит и пишет в цель ссылки, plans создаётся внутри цели (0700)
    const out = parsed(await client.callTool({ name: "project_export_plan", arguments: { path: "x.plan" } }));
    assert.equal(out["relative_path"], "x.plan");
    assert.ok(existsSync(join(outsideDir, "plans", "x.plan")), "файл внутри цели ссылки /plans");
    assert.equal(mode(join(outsideDir, "plans")), 0o700, "plans внутри цели 0700");
    // сам каталог состояния (цель ссылки) чинится до 0700, как и для обычного
    // HOME (ревью 164 m7) — так же ведут себя backups/renders на d714539
    assert.equal(mode(outsideDir), 0o700);
    // roundtrip import: файл читается обратно
    const imp = parsed(await client.callTool({ name: "project_import_plan", arguments: { path: "x.plan", replace: true } }));
    assert.equal(imp["relative_path"], "x.plan");
    // соседние каталоги (keep.txt) не затронуты
    assert.ok(existsSync(join(outsideDir, "keep.txt")));
  } finally {
    await client.close();
    rmSync(HOME_DIR, { force: true });
    if (existsSync(bak)) renameSync(bak, HOME_DIR);
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// №2: соседний каталог с общим префиксом отклоняется лексическим слоем
// (точное сообщение); при мутации «startsWith без разделителя + без realpath»
// тест краснеет — путь уходит в plans-evil.
test("plans-root: resolvePlanPath — соседний каталог plans-evil отклонён лексическим слоем", () => {
  mkdirSync(join(HOME_DIR, "plans-evil"), { recursive: true });
  try {
    assert.throws(
      () => resolvePlanPath(join(HOME_DIR, "plans-evil", "x.plan")),
      (e: { code: string; message: string }) =>
        e.code === "INVALID_ARGUMENT" && e.message.startsWith("путь выходит за корень plans ("),
      "лексический слой (не realpath-слой) должен отклонить plans-evil",
    );
  } finally {
    rmSync(join(HOME_DIR, "plans-evil"), { recursive: true, force: true });
  }
});

// №5: имя, начинающееся с точек, внутри корня — не выход за корень
test("plans-root: имя ..kitchen.plan внутри корня допустимо", async () => {
  const client = await start();
  try {
    const res = resolvePlanPath("..kitchen.plan");
    assert.equal(res.relative, "..kitchen.plan");
    const out = parsed(await client.callTool({ name: "project_export_plan", arguments: { path: "..kitchen.plan" } }));
    assert.equal(out["relative_path"], "..kitchen.plan");
    assert.ok(existsSync(join(PLANS_DIR, "..kitchen.plan")));
  } finally {
    await client.close();
    rmSync(join(PLANS_DIR, "..kitchen.plan"), { force: true });
  }
});

// №6: расширение без учёта регистра (x.PLAN — принять), но имя без файла
// сравнивается так же без учёта регистра (a/.PLAN — отклонить, как a/.plan)
test("plans-root: регистр расширения — up.PLAN принимается, a/.PLAN отклоняется как имя без файла", async () => {
  const client = await start();
  try {
    const out = parsed(await client.callTool({ name: "project_export_plan", arguments: { path: "up.PLAN" } }));
    assert.equal(out["relative_path"], "up.PLAN");
    assert.ok(existsSync(join(PLANS_DIR, "up.PLAN")));
    const err = await callError(client, "project_export_plan", { path: "a/.PLAN" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /без имени файла/);
  } finally {
    await client.close();
    rmSync(join(PLANS_DIR, "up.PLAN"), { force: true });
  }
});

// №6: `~/x.plan` — отказ с подсказкой «относительно каталога plans», каталог `~` не создаётся
test("plans-root: путь вида ~/… отклонён с подсказкой, каталог ~ не создан", async () => {
  const client = await start();
  try {
    const err = await callError(client, "project_export_plan", { path: "~/x.plan" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /относительно каталога plans/);
    assert.ok(!existsSync(join(PLANS_DIR, "~")), "каталог с именем ~ не создан");
  } finally {
    await client.close();
  }
});

// №4: нулевой байт — явный INVALID_ARGUMENT, а не INTERNAL
test("plans-root: нулевой байт в пути отклонён явно", () => {
  assert.throws(
    () => resolvePlanPath("x\u0000.plan"),
    (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /нулевой байт/.test(e.message),
  );
});

// №4: ENAMETOOLONG и EEXIST — понятный INVALID_ARGUMENT, не INTERNAL
test("plans-root: слишком длинное имя пути — INVALID_ARGUMENT, а не INTERNAL", async () => {
  const client = await start();
  try {
    const err = await callError(client, "project_export_plan", { path: "a".repeat(300) + ".plan" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /слишком длинное/);
  } finally {
    await client.close();
  }
});

test("plans-root: компонент пути — обычный файл (mkdir EEXIST) — INVALID_ARGUMENT, а не INTERNAL", async () => {
  const client = await start();
  try {
    writeFileSync(join(PLANS_DIR, "f"), "x");
    const err = await callError(client, "project_export_plan", { path: "f/x.plan" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /уже существует/);
  } finally {
    await client.close();
    rmSync(join(PLANS_DIR, "f"), { force: true });
  }
});

// №8: ошибка import показывает относительный путь целиком (с подкаталогом)
test("plans-root: ошибка import для 2026/missing.plan показывает относительный путь с подкаталогом", async () => {
  const client = await start();
  try {
    const err = await callError(client, "project_import_plan", { path: "2026/missing.plan", replace: true });
    assert.equal(err.code, "NOT_FOUND");
    assert.match(err.message, /2026\/missing\.plan/);
  } finally {
    await client.close();
  }
});

// №7: жёсткая ссылка внутри plans на внешний файл — import отклоняется
test("plans-root: import файла с несколькими жёсткими ссылками (nlink>1) отклонён", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-hl-"));
  try {
    writeFileSync(join(outsideDir, "secret.plan"), '{"walls":{}}');
    linkSync(join(outsideDir, "secret.plan"), join(PLANS_DIR, "hl.plan"));
    const err = await callError(client, "project_import_plan", { path: "hl.plan", replace: true });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /жёстких ссылок/);
  } finally {
    await client.close();
    rmSync(join(PLANS_DIR, "hl.plan"), { force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// №3 (TOCTOU): подкаталог, подменённый на ссылку, не даёт записать файл наружу
test("plans-root: подкаталог-ссылка после resolve — export отклонён, внешний каталог не изменён", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-toctou-"));
  try {
    resolvePlanPath("sub/x.plan");
    chmodSync(outsideDir, 0o755);
    symlinkSync(outsideDir, join(PLANS_DIR, "sub"));
    const err = await callError(client, "project_export_plan", { path: "sub/x.plan" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.deepEqual(readdirSync(outsideDir), [], "внешний каталог не изменён");
  } finally {
    await client.close();
    rmSync(join(PLANS_DIR, "sub"), { force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// №9 (ревью 216): ошибки ФС при подготовке корня plans внутри resolvePlanPath
// (ensurePrivateDir/realpathSync/rejectSymlinkRoots) — понятный INVALID_ARGUMENT,
// а не INTERNAL (регрессия против d714539)
test("plans-root: HOME без записи (0500), plans ещё нет — export даёт INVALID_ARGUMENT «нет доступа», не INTERNAL", async () => {
  const client = await start();
  const prev = mode(HOME_DIR);
  try {
    rmSync(PLANS_DIR, { recursive: true, force: true });
    assert.ok(!existsSync(PLANS_DIR), "plans ещё не создан");
    chmodSync(HOME_DIR, 0o500);
    const err = await callError(client, "project_export_plan", { path: "x.plan" });
    assert.equal(err.code, "INVALID_ARGUMENT", `ожидался INVALID_ARGUMENT, получено: ${err.code} ${err.message}`);
    assert.match(err.message, /каталог plans недоступен/);
    assert.doesNotMatch(err.message, /внутренняя ошибка/);
    // тот же отказ и для import
    const err2 = await callError(client, "project_import_plan", { path: "x.plan", replace: true });
    assert.equal(err2.code, "INVALID_ARGUMENT");
    assert.match(err2.message, /каталог plans недоступен/);
  } finally {
    await client.close();
    chmodSync(HOME_DIR, prev);
  }
});

// №10 (ревью 216): подмена подкаталога на ссылку МЕЖДУ resolvePlanPath и операцией —
// повторная проверка realpath (assertDirStillInside перед записью) отклоняет её
test("plans-root: TOCTOU — подкаталог заменён на ссылку после resolve, assertDirStillInside отклоняет", () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-tt-dir-"));
  const sub = join(PLANS_DIR, "sub");
  const subBak = sub + ".bak";
  try {
    mkdirSync(sub, { recursive: true });
    const resolved = resolvePlanPath("sub/x.plan");
    chmodSync(outsideDir, 0o755);
    renameSync(sub, subBak);
    symlinkSync(outsideDir, sub);
    assert.throws(
      () => assertDirStillInside(resolved),
      (e: { code: string; message: string }) =>
        e.code === "INVALID_ARGUMENT" && /выходит за корень plans/.test(e.message),
      "повторная проверка realpath каталога назначения должна отклонить подмену",
    );
    assert.deepEqual(readdirSync(outsideDir), [], "внешний каталог не изменён");
  } finally {
    rmSync(sub, { force: true });
    if (existsSync(subBak)) {
      renameSync(subBak, sub);
      rmSync(sub, { recursive: true, force: true });
    }
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// №10 (ревью 216): подмена файла на ссылку МЕЖДУ проверкой (inspectPath) и
// открытием — O_NOFOLLOW при открытии даёт ELOOP, чтение чужого файла не
// происходит. Подмена выполняется в момент открытия через инъекционную точку
// fsWriteCalls.openSync; тело по ссылке — валидная модель, поэтому мутация
// «без O_NOFOLLOW» прочитала бы чужой файл без ошибки (тест краснеет).
test("plans-root: TOCTOU — файл заменён на ссылку между проверкой и открытием, readPlanFile отклоняет (O_NOFOLLOW)", () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-tt-file-"));
  const realOpen = fsWriteCalls.openSync;
  try {
    mkdirSync(PLANS_DIR, { recursive: true });
    writeFileSync(join(PLANS_DIR, "x.plan"), JSON.stringify({ walls: {} }));
    // валидная модель, чтобы мутация без O_NOFOLLOW не споткнулась о разбор
    const evilModel = { v: 3, id: "0", plan_id: "0", walls: {}, items: {}, pillars: {}, rulers: {}, comments: {}, total_height: 270, final: true };
    writeFileSync(join(outsideDir, "evil.plan"), JSON.stringify(evilModel));
    const resolved = resolvePlanPath("x.plan");
    fsWriteCalls.openSync = ((path: Parameters<typeof realOpen>[0], flags: number, mode?: number) => {
      // подмена ровно между inspectPath и открытием
      renameSync(join(PLANS_DIR, "x.plan"), join(PLANS_DIR, "x.real"));
      symlinkSync(join(outsideDir, "evil.plan"), join(PLANS_DIR, "x.plan"));
      return realOpen(path, flags, mode);
    }) as typeof realOpen;
    assert.throws(
      () => readPlanFile(resolved.absolute, { display: resolved.relative }),
      (e: { code: string; message: string }) =>
        e.code === "INVALID_ARGUMENT" && /символическую ссылку/.test(e.message),
      "чтение через O_NOFOLLOW должно отклонить подмену файла на ссылку (ELOOP)",
    );
    assert.equal(readFileSync(join(outsideDir, "evil.plan"), "utf8"), JSON.stringify(evilModel), "внешний файл не изменён");
  } finally {
    fsWriteCalls.openSync = realOpen;
    rmSync(join(PLANS_DIR, "x.plan"), { force: true });
    rmSync(join(PLANS_DIR, "x.real"), { force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// №12 (ревью 216): любой ведущий `~` отклоняется с подсказкой —
// `~user/x.plan` больше не создаёт каталог `~user` в корне
test("plans-root: путь вида ~user/x.plan отклонён с подсказкой, каталог ~user не создан", async () => {
  const client = await start();
  try {
    const err = await callError(client, "project_export_plan", { path: "~user/x.plan" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /относительно каталога plans/);
    assert.ok(!existsSync(join(PLANS_DIR, "~user")), "каталог ~user не создан");
  } finally {
    await client.close();
  }
});

// ---------- ревью 218: №13–№16 ----------

/** Подмена каталога в момент первой повторной проверки realpath (fsCheckCalls):
 *  выполняется ровно между resolvePlanPath и проверкой в обработчике — тест
 *  краснеет, если вызов assertDirStillInside убран из обработчика (№13). */
function swapOnFirstCheck(swap: () => void): void {
  const real = fsCheckCalls.realpathSync;
  let swapped = false;
  fsCheckCalls.realpathSync = ((p: Parameters<typeof real>[0]) => {
    if (!swapped) {
      swapped = true;
      swap();
    }
    return real(p);
  }) as typeof real;
}

// №13: подмена подкаталога между resolve и операцией — через САМ обработчик
// export (не прямой вызов assertDirStillInside): удаление проверки из
// обработчика красит тест — подмена не выполнится и export запишет наружу.
test("plans-root №13: обработчик export отклоняет подкаталог, подменённый после resolve (fsCheckCalls), снаружи ничего не записано", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-h13-exp-"));
  const sub = join(PLANS_DIR, "sub");
  const subBak = sub + ".bak";
  const real = fsCheckCalls.realpathSync;
  try {
    mkdirSync(sub, { recursive: true });
    resolvePlanPath("sub/x.plan");
    chmodSync(outsideDir, 0o755);
    swapOnFirstCheck(() => {
      renameSync(sub, subBak);
      symlinkSync(outsideDir, sub);
    });
    const err = await callError(client, "project_export_plan", { path: "sub/x.plan" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /выходит за корень plans/);
    assert.deepEqual(readdirSync(outsideDir), [], "внешний каталог не изменён");
  } finally {
    fsCheckCalls.realpathSync = real;
    await client.close();
    rmSync(sub, { force: true });
    if (existsSync(subBak)) {
      renameSync(subBak, sub);
      rmSync(sub, { recursive: true, force: true });
    }
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// №13: то же для обработчика import — по ссылке лежит валидная модель, поэтому
// без проверки в обработчике импорт чужого файла прошёл бы (тест краснеет).
test("plans-root №13: обработчик import отклоняет подкаталог, подменённый после resolve, чужая модель не импортируется", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-h13-imp-"));
  const sub = join(PLANS_DIR, "sub");
  const subBak = sub + ".bak";
  const real = fsCheckCalls.realpathSync;
  try {
    mkdirSync(sub, { recursive: true });
    // внутри plans — пустая модель, в цели ссылки — валидная чужая модель:
    // без проверки в обработчике импорт прочитал бы именно её
    const evilModel = { v: 3, id: "0", plan_id: "0", walls: {}, items: {}, pillars: {}, rulers: {}, comments: {}, total_height: 270, final: true };
    writeFileSync(join(sub, "x.plan"), JSON.stringify({ walls: {} }));
    writeFileSync(join(outsideDir, "x.plan"), JSON.stringify(evilModel));
    resolvePlanPath("sub/x.plan");
    swapOnFirstCheck(() => {
      renameSync(sub, subBak);
      symlinkSync(outsideDir, sub);
    });
    const err = await callError(client, "project_import_plan", { path: "sub/x.plan", replace: true });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /выходит за корень plans/);
    assert.equal(readFileSync(join(outsideDir, "x.plan"), "utf8"), JSON.stringify(evilModel), "чужой файл не изменён");
  } finally {
    fsCheckCalls.realpathSync = real;
    await client.close();
    rmSync(sub, { force: true });
    if (existsSync(subBak)) {
      renameSync(subBak, sub);
      rmSync(sub, { recursive: true, force: true });
    }
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// №14: корень plans подменён после resolve, каталога назначения ещё нет —
// проверяется ближайший существующий предок; снаружи не создаётся даже
// пустого каталога (ensurePrivateDir не выполняется по подменённой ссылке).
test("plans-root №14: подмена корня plans после resolve при несуществующем подкаталоге — export отклонён, снаружи не создано ничего", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-h14-"));
  const plansBak = PLANS_DIR + ".h14bak";
  const real = fsCheckCalls.realpathSync;
  try {
    resolvePlanPath("sub/x.plan");
    chmodSync(outsideDir, 0o755);
    swapOnFirstCheck(() => {
      renameSync(PLANS_DIR, plansBak);
      symlinkSync(outsideDir, PLANS_DIR);
    });
    const err = await callError(client, "project_export_plan", { path: "sub/x.plan" });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /выходит за корень plans/);
    assert.deepEqual(readdirSync(outsideDir), [], "снаружи не создано даже пустого каталога");
  } finally {
    fsCheckCalls.realpathSync = real;
    await client.close();
    rmSync(PLANS_DIR, { force: true });
    if (existsSync(plansBak)) renameSync(plansBak, PLANS_DIR);
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// №15: HOME — symlink, абсолютный путь через РЕАЛЬНУЮ цель (realpath(HOME)/plans)
// указывает на тот же каталог — принимается (ложного отказа «выходит за корень»
// нет); путь через ссылку и отказ для пути вне корня не меняются
test("plans-root №15: HOME-symlink — абсолютный путь через реальную цель ссылки принимается", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-h15-"));
  const bak = HOME_DIR + ".h15bak";
  try {
    renameSync(HOME_DIR, bak);
    symlinkSync(outsideDir, HOME_DIR);
    const realPlans = join(outsideDir, "plans");
    const abs = join(realPlans, "real.plan");
    const out = parsed(await client.callTool({ name: "project_export_plan", arguments: { path: abs } }));
    // ревью 222 №1: path в ответе нормализован к реальному корню
    // join(realRoot, rel) — на macOS /var и /private/var дают разные написания
    // одного и того же каталога (позитив — что путь принят, сравнение по realpath)
    assert.equal(realpathSync(out["path"] as string), realpathSync(abs));
    assert.equal(out["relative_path"], "real.plan");
    assert.ok(existsSync(abs), "файл внутри plans цели ссылки");
    // import того же реального пути — тоже принимается
    const imp = parsed(await client.callTool({ name: "project_import_plan", arguments: { path: abs, replace: true } }));
    assert.equal(imp["relative_path"], "real.plan");
    // путь через саму ссылку HOME работает, как раньше
    await client.callTool({ name: "project_export_plan", arguments: { path: "via-link.plan" } });
    assert.ok(existsSync(join(realPlans, "via-link.plan")));
    // абсолютный путь вне корня по-прежнему отклонён
    const err = await callError(client, "project_export_plan", { path: join(outsideDir, "esc.plan") });
    assert.equal(err.code, "INVALID_ARGUMENT");
  } finally {
    await client.close();
    rmSync(HOME_DIR, { force: true });
    if (existsSync(bak)) renameSync(bak, HOME_DIR);
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// ревью 222 №1/A: внешняя символическая ссылка ВНУТРЬ корня (<ext>/l → plans/sub).
// На 4773b1a realpath всего кандидата разрешал ссылку — путь принимался и файл
// создавался в plans/sub (регрессия против 633b9bb); после фикса префикс
// <ext>/l — не алиас самого корня — отказ «выходит за корень»
test("plans-root 222 A: внешняя ссылка внутрь plans отклонена (export и import)", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-222a-"));
  const sub = join(PLANS_DIR, "sub");
  try {
    mkdirSync(sub, { recursive: true });
    // валидная модель в цели ссылки: на 4773b1a import через ссылку проходил
    const evilModel = { v: 3, id: "0", plan_id: "0", walls: {}, items: {}, pillars: {}, rulers: {}, comments: {}, total_height: 270, final: true };
    writeFileSync(join(sub, "m.plan"), JSON.stringify(evilModel));
    symlinkSync(sub, join(outsideDir, "l"));
    const err = await callError(client, "project_export_plan", { path: join(outsideDir, "l", "a.plan") });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /выходит за корень plans/);
    const err2 = await callError(client, "project_import_plan", { path: join(outsideDir, "l", "m.plan"), replace: true });
    assert.equal(err2.code, "INVALID_ARGUMENT");
    assert.match(err2.message, /выходит за корень plans/);
    assert.ok(!existsSync(join(sub, "a.plan")), "файл по внешней ссылке не создан");
    assert.equal(readFileSync(join(sub, "m.plan"), "utf8"), JSON.stringify(evilModel), "файл в корне не изменён");
  } finally {
    await client.close();
    rmSync(sub, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// ревью 222 №1/B: внутренняя ссылка plans/link → plans/sub. Ревью 226 №2:
// путь задаётся через внешнюю ссылку на HOME (<ext>/up/plans/link/…, как в E) —
// он нелексический на ЛЮБОЙ ОС (раньше путь realRoot/link/… попадал в ветку
// !insideLexical только на macOS, где tmpdir лежит под /var → /private/var;
// на Linux realRoot == PLANS_DIR и тест проверял лексическую ветку).
// На 4773b1a realpath кандидата разрешал ссылку и путь принимался; после
// фикса symlink в хвосте ловит прежний цикл lstat (#33)
test("plans-root 222 B: внутренняя ссылка по реальному пути корня отклонена (export и import)", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-222b-"));
  const sub = join(PLANS_DIR, "sub");
  const link = join(PLANS_DIR, "link");
  try {
    mkdirSync(sub, { recursive: true });
    const evilModel = { v: 3, id: "0", plan_id: "0", walls: {}, items: {}, pillars: {}, rulers: {}, comments: {}, total_height: 270, final: true };
    writeFileSync(join(sub, "m.plan"), JSON.stringify(evilModel));
    symlinkSync(sub, link);
    symlinkSync(HOME_DIR, join(outsideDir, "up"));
    const err = await callError(client, "project_export_plan", { path: join(outsideDir, "up", "plans", "link", "b.plan") });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /символическую ссылку/);
    const err2 = await callError(client, "project_import_plan", { path: join(outsideDir, "up", "plans", "link", "m.plan"), replace: true });
    assert.equal(err2.code, "INVALID_ARGUMENT");
    assert.match(err2.message, /символическую ссылку/);
    assert.ok(!existsSync(join(sub, "b.plan")), "файл по ссылке не создан");
  } finally {
    await client.close();
    rmSync(link, { force: true });
    rmSync(sub, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// ревью 222 №2/D: циклическая символическая ссылка — понятный INVALID_ARGUMENT
// «выходит за корень plans», а не INTERNAL (на 4773b1a ELOOP от realpath
// кандидата уходил сырым исключением и абстрактный путь — в stderr сервера)
test("plans-root 222 D: циклическая ссылка — INVALID_ARGUMENT, не INTERNAL", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-222d-"));
  try {
    const loop = join(outsideDir, "loop");
    symlinkSync(loop, loop);
    const err = await callError(client, "project_export_plan", { path: join(loop, "d.plan") });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /выходит за корень plans/);
    assert.ok(!existsSync(join(loop, "d.plan")), "файл не создан");
  } finally {
    await client.close();
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// ревью 222 №1/E: внешняя ссылка на КОРЕНЬ (<ext>/up → HOME): путь
// <ext>/up/plans/e.plan — псевдоним самого корня, по смыслу равен разрешённому
// symlink-HOME (№15), принимается; операция идёт по join(realRoot, rel) —
// path в ответе под realRoot, файл внутри plans, а не по внешней ссылке
test("plans-root 222 E: путь через внешнюю ссылку на корень принят, операция идёт внутри realRoot", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-222e-"));
  try {
    symlinkSync(HOME_DIR, join(outsideDir, "up"));
    const res = parsed(await client.callTool({ name: "project_export_plan", arguments: { path: join(outsideDir, "up", "plans", "e.plan") } }));
    const realRoot = realpathSync(PLANS_DIR);
    // на 4773b1a path = путь пользователя ЧЕРЕЗ внешнюю ссылку (лексически вне
    // realRoot) — операция шла бы по ссылке, которой управляет чужой каталог
    assert.ok((res["path"] as string).startsWith(realRoot + "/"), "path лексически под realRoot");
    assert.equal(realpathSync(res["path"] as string), join(realRoot, "e.plan"), "path — внутри реального корня");
    assert.equal(res["relative_path"], "e.plan");
    assert.ok(existsSync(join(PLANS_DIR, "e.plan")), "файл создан внутри plans");
  } finally {
    await client.close();
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// ревью 226 №1: ссылка ВНУТРИ корня на сам корень (plans/sub/back → plans,
// plans/self → plans). Подъём по префиксу раньше останавливался на самом
// глубоком совпадении — хвост после ссылки «проглатывался» и путь принимался
// (регрессия против 633b9bb); после фикса берётся самый короткий совпадающий
// префикс, ссылка в хвосте ловит цикл lstat — «символическую ссылку».
// S1/S2 — путь по реальному корню (на macOS лексически вне PLANS_DIR из-за
// /var → /private/var), S3 — через внешнюю ссылку на HOME: гарантированно
// нелексический на любой ОС
test("plans-root 226 S: ссылка внутри корня на сам корень отклонена (export и import)", async () => {
  const client = await start();
  const outsideDir = mkdtempSync(join(tmpdir(), "plans-226s-"));
  const sub = join(PLANS_DIR, "sub");
  const back = join(sub, "back");
  const self = join(PLANS_DIR, "self");
  try {
    mkdirSync(sub, { recursive: true });
    symlinkSync(PLANS_DIR, back);
    symlinkSync(PLANS_DIR, self);
    const realRoot = realpathSync(PLANS_DIR);
    symlinkSync(HOME_DIR, join(outsideDir, "up"));
    const err = await callError(client, "project_export_plan", { path: join(realRoot, "sub", "back", "s1.plan") });
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(err.message, /символическую ссылку/);
    const err2 = await callError(client, "project_import_plan", { path: join(realRoot, "self", "s2.plan"), replace: true });
    assert.equal(err2.code, "INVALID_ARGUMENT");
    assert.match(err2.message, /символическую ссылку/);
    const err3 = await callError(client, "project_export_plan", { path: join(outsideDir, "up", "plans", "self", "s3.plan") });
    assert.equal(err3.code, "INVALID_ARGUMENT");
    assert.match(err3.message, /символическую ссылку/);
    assert.ok(!existsSync(join(realRoot, "s1.plan")), "файл не создан в корне (S1)");
    assert.ok(!existsSync(join(realRoot, "s2.plan")), "файл не создан в корне (S2)");
    assert.ok(!existsSync(join(realRoot, "s3.plan")), "файл не создан в корне (S3)");
  } finally {
    await client.close();
    rmSync(back, { force: true });
    rmSync(self, { force: true });
    rmSync(sub, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// №16: ошибки стадии подготовки корня называют корень plans, а не путь
// пользователя; единый текст для export и import, без абсолютных путей
test("plans-root №16: plans — обычный файл → «каталог plans недоступен» без имени пути пользователя", async () => {
  const client = await start();
  const plansBak = PLANS_DIR + ".h16a";
  try {
    renameSync(PLANS_DIR, plansBak);
    writeFileSync(PLANS_DIR, "x");
    for (const [name, args] of [
      ["project_export_plan", { path: "x.plan" }],
      ["project_import_plan", { path: "x.plan", replace: true }],
    ] as const) {
      const err = await callError(client, name, args as Record<string, unknown>);
      assert.equal(err.code, "INVALID_ARGUMENT", name);
      assert.match(err.message, /каталог plans недоступен/, name);
      assert.doesNotMatch(err.message, /x\.plan/, `${name}: путь пользователя в ошибке подготовки корня не называется`);
    }
  } finally {
    await client.close();
    rmSync(PLANS_DIR, { force: true });
    if (existsSync(plansBak)) renameSync(plansBak, PLANS_DIR);
  }
});

// №16: HOME — обычный файл (ENOTDIR у корня) — тот же понятный отказ,
// а не NOT_FOUND «файл не найден: x.plan»
test("plans-root №16: HOME — обычный файл → «каталог plans недоступен»", async () => {
  const client = await start();
  const homeBak = HOME_DIR + ".h16b";
  try {
    renameSync(HOME_DIR, homeBak);
    writeFileSync(HOME_DIR, "x");
    for (const [name, args] of [
      ["project_export_plan", { path: "x.plan" }],
      ["project_import_plan", { path: "x.plan", replace: true }],
    ] as const) {
      const err = await callError(client, name, args as Record<string, unknown>);
      assert.equal(err.code, "INVALID_ARGUMENT", name);
      assert.match(err.message, /каталог plans недоступен/, name);
      assert.doesNotMatch(err.message, /x\.plan/, name);
    }
  } finally {
    await client.close();
    rmSync(HOME_DIR, { force: true });
    if (existsSync(homeBak)) renameSync(homeBak, HOME_DIR);
  }
});
