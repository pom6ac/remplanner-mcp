// 163 b3b4 (аудит 65, B3+B4): единая утилита файловых операций — права 0700/0600,
// починка существующих прав, атомарная запись, traversal в backupPath, нечисловые
// id на границе, symlink/oversize при импорте, credentials с широкими правами.
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDir, writePrivateFile, inspectPath } from "../../src/fs-safe.ts";
import { readCredentials } from "../../src/credentials.ts";
import { readPlanFile, MAX_PLAN_FILE_BYTES } from "../../src/server/tools-projects.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import { BACKUPS_DIR } from "../../src/config.ts";
import { McpError } from "../../src/errors.ts";

const ROOT = mkdtempSync(join(tmpdir(), "b3b4-files-"));
const mode = (p: string): number => statSync(p).mode & 0o777;

test("ensurePrivateDir: создаёт 0700, чинит существующий широкий каталог", () => {
  const dir = join(ROOT, "d1");
  ensurePrivateDir(dir);
  assert.equal(mode(dir), 0o700);

  chmodSync(dir, 0o775);
  ensurePrivateDir(dir);
  assert.equal(mode(dir), 0o700);

  const nested = join(dir, "a", "b");
  ensurePrivateDir(nested);
  assert.equal(mode(nested), 0o700);
  assert.equal(mode(dir), 0o700);
});

test("writePrivateFile: новый файл 0600, перезапись чинит 0644 → 0600, tmp не остаётся", () => {
  const dir = join(ROOT, "w1");
  ensurePrivateDir(dir);
  const file = join(dir, "plan.json");

  writePrivateFile(file, '{"a":1}');
  assert.equal(mode(file), 0o600);
  assert.equal(readFileSync(file, "utf8"), '{"a":1}');

  chmodSync(file, 0o644);
  writePrivateFile(file, '{"a":2}');
  assert.equal(mode(file), 0o600);
  assert.equal(readFileSync(file, "utf8"), '{"a":2}');

  const leftovers = readdirSync(dir).filter((f) => f.startsWith("."));
  assert.deepEqual(leftovers, [], "временный файл удалён rename'ом");
});

test("writePrivateFile: отказ на symlink-цель, содержимое цели не трогается", () => {
  const dir = join(ROOT, "w2");
  ensurePrivateDir(dir);
  const target = join(dir, "target.txt");
  writeFileSync(target, "keep");
  const link = join(dir, "link.json");
  symlinkSync(target, link);

  assert.throws(() => writePrivateFile(link, "evil"), (e: McpError) => {
    assert.equal(e.code, "INVALID_ARGUMENT");
    assert.match(e.message, /символическая ссылка/);
    return true;
  });
  assert.equal(readFileSync(target, "utf8"), "keep");
  assert.ok(inspectPath(link).symlink, "ссылка не заменена файлом");
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(".")), [], "tmp удалён после отказа");
});

test("writePrivateFile: отказ на каталог-цель; запись в несуществующий каталог не создаёт его", () => {
  const dir = join(ROOT, "w3");
  ensurePrivateDir(dir);
  assert.throws(() => writePrivateFile(dir, "x"), (e: McpError) => e.code === "INVALID_ARGUMENT");

  const missing = join(dir, "nodir", "x.plan");
  assert.throws(() => writePrivateFile(missing, "x"), (e: NodeJS.ErrnoException) => e.code === "ENOENT");
  assert.ok(!statSync(join(dir, "nodir"), { throwIfNoEntry: false }), "каталог не создан");
});

// ---------- credentials: широкие права — отказ ДО чтения ----------

test("credentials: права файла 0644 → отказ с chmod-подсказкой, без значений секретов", () => {
  const dir = join(ROOT, "cred1");
  ensurePrivateDir(dir);
  const file = join(dir, "credentials.env");
  writeFileSync(file, "REMPLANNER_LOGIN=u@x\nREMPLANNER_PASSWORD=topsecret\n");
  chmodSync(file, 0o644);
  assert.throws(() => readCredentials(file), (e: McpError) => {
    assert.equal(e.code, "AUTH_REQUIRED");
    assert.match(e.hint ?? "", /chmod 600/);
    const json = JSON.stringify(e.toJSON());
    assert.ok(!json.includes("topsecret"));
    assert.ok(!json.includes("u@x"));
    return true;
  });
});

test("credentials: широкий каталог → отказ с chmod 700", () => {
  const dir = join(ROOT, "cred2");
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const file = join(dir, "credentials.env");
  writeFileSync(file, "REMPLANNER_LOGIN=u@x\nREMPLANNER_PASSWORD=p\n");
  chmodSync(file, 0o600);
  assert.throws(() => readCredentials(file), (e: McpError) => {
    assert.equal(e.code, "AUTH_REQUIRED");
    assert.match(e.message, /каталог/);
    assert.match(e.hint ?? "", /chmod 700/);
    return true;
  });
});

test("credentials: symlink вместо файла → отказ", () => {
  const dir = join(ROOT, "cred3");
  ensurePrivateDir(dir);
  const real = join(dir, "real.env");
  writeFileSync(real, "REMPLANNER_LOGIN=u@x\nREMPLANNER_PASSWORD=p\n");
  chmodSync(real, 0o600);
  const link = join(dir, "credentials.env");
  symlinkSync(real, link);
  assert.throws(() => readCredentials(link), (e: McpError) => {
    assert.equal(e.code, "AUTH_REQUIRED");
    assert.match(e.message, /символическая ссылка/);
    return true;
  });
});

// ---------- import: symlink / не-обычный файл / oversize до чтения ----------

test("readPlanFile: symlink, каталог и oversize отклонены до чтения; лимит по умолчанию", () => {
  const dir = join(ROOT, "imp");
  ensurePrivateDir(dir);

  const real = join(dir, "real.plan");
  writeFileSync(real, '{"walls":{}}');
  const link = join(dir, "link.plan");
  symlinkSync(real, link);
  assert.throws(() => readPlanFile(link), (e: McpError) => {
    assert.equal(e.code, "INVALID_ARGUMENT");
    assert.match(e.message, /символической ссылкой/);
    return true;
  });

  assert.throws(() => readPlanFile(dir), (e: McpError) => {
    assert.equal(e.code, "INVALID_ARGUMENT");
    assert.match(e.message, /не является обычным файлом/);
    return true;
  });

  assert.equal(MAX_PLAN_FILE_BYTES > 1024, true, "лимит по умолчанию задан");
  assert.throws(
    () => readPlanFile(real, { maxBytes: 4 }),
    (e: McpError) => {
      assert.equal(e.code, "INVALID_ARGUMENT");
      assert.match(e.message, /слишком большой/);
      return true;
    },
  );
  // обычный файл в пределах лимита читается
  const model = readPlanFile(real);
  assert.deepEqual(model, { walls: {} });
});

// ---------- нечисловые id на границе (Workspace.open) ----------

function mockDeps(): WorkspaceDeps {
  const editor: EditorLike = {
    objectId: "123", planId: "1",
    async normalize(model) {
      return { model: structuredClone(model) as Record<string, unknown>, rooms: [], before: { walls: 0, holes: 0, items: 0 }, after: { walls: 0, holes: 0, items: 0 } };
    },
    async save() { return { ok: true, saveId: "s1", conflict: false }; },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { throw new Error("not used"); },
    async close() {},
  };
  return {
    session: { cookies: [] },
    async loadModel(_s, _oid, _pid) {
      return { object_id: "123", plan_id: "1", save_id: "s1", units: "cm", model: { walls: {} } as unknown as Record<string, unknown>, data_empty: true };
    },
    async openEditor() { return editor; },
  };
}

test("Workspace.open: нечисловой object_id/plan_id отклонён с traversal-строкой", async () => {
  const ws = new Workspace(mockDeps());
  for (const bad of ["../etc", "1/2", "abc", "1; rm -rf", ""]) {
    await assert.rejects(ws.open(bad), (e: McpError) => {
      assert.equal(e.code, "INVALID_ARGUMENT");
      assert.match(e.message, /числовым/);
      return true;
    });
  }
  await assert.rejects(ws.open("123", "../x"), (e: McpError) => {
    assert.equal(e.code, "INVALID_ARGUMENT");
    assert.match(e.message, /plan_id/);
    return true;
  });
});

// ---------- backupPath: безопасный basename + containment ----------

test("backupPath: objectId с ../ не выходит за BACKUPS_DIR, файл 0600, каталог 0700", async () => {
  const ws = new Workspace(mockDeps());
  await ws.open("123", "1");
  // подмена полей проекта в обход границы — защита в backupPath/writeBackup
  const p = (ws as unknown as { project: { objectId: string; planId: string } }).project;
  p.objectId = "../../evil";
  p.planId = "../x";

  const path = (ws as unknown as { backupPath(): string }).backupPath();
  assert.ok(!path.includes("/.."), "traversal-последовательности нет в имени");
  assert.ok(path.startsWith(BACKUPS_DIR + "/"), "путь внутри BACKUPS_DIR");

  const written = (ws as unknown as { writeBackup(): string }).writeBackup();
  const root = statSync(BACKUPS_DIR);
  assert.equal(root.mode & 0o777, 0o700, "backups 0700");
  assert.equal(statSync(written).mode & 0o777, 0o600, "снимок 0600");
  assert.ok(readFileSync(written, "utf8").startsWith("{"), "снимок записан");
  assert.deepEqual(readdirSync(BACKUPS_DIR).filter((f) => f.startsWith(".")), [], "tmp не остался");

  rmSync(written, { force: true });
});

test("writePrivateFile: буфер (PNG-сценарий render) — 0600", () => {
  const dir = join(ROOT, "render");
  ensurePrivateDir(dir);
  const png = join(dir, "123-x.png");
  writePrivateFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.equal(mode(png), 0o600);
  assert.equal(readFileSync(png).byteLength, 8);
});
