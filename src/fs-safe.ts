import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { McpError } from "./errors.ts";
import { HOME_DIR } from "./config.ts";

// B4 (аудит 65): единая граница файловых операций — каталоги состояния 0700,
// файлы с планами/сессиями/бэкапами/рендерами 0600, запись атомарная
// (tmp в том же каталоге + rename), существующие широкие права чинятся chmod.

/** Права каталогов состояния (HOME_DIR и подкаталоги). */
export const PRIVATE_DIR_MODE = 0o700;
/** Права файлов с приватным содержимым (план, сессия, бэкап, кэш каталога, PNG). */
export const PRIVATE_FILE_MODE = 0o600;

/** Владелец пути — текущий пользователь (на платформах без uid — true). */
export function ownedByCurrentUser(path: string): boolean {
  const getuid = (process as { getuid?: () => number }).getuid;
  if (typeof getuid !== "function") return true;
  try {
    return statSync(path).uid === getuid.call(process);
  } catch {
    return false;
  }
}

/**
 * Создать каталог (рекурсивно) и гарантировать 0700 — в том числе для существующего.
 * Ревью 164 m7: для подкаталога HOME_DIR (backups/cache/renders) чинится и сам
 * HOME_DIR — иначе каталог состояния остаётся широким, пока не записана сессия.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // mkdirSync не чинит права уже существующего каталога — chmod явно.
  chmodSync(dir, PRIVATE_DIR_MODE);
  if (dir !== HOME_DIR && dirname(dir) === HOME_DIR && ownedByCurrentUser(HOME_DIR)) {
    try {
      chmodSync(HOME_DIR, PRIVATE_DIR_MODE);
    } catch {
      // чинить нельзя (например, EPERM) — не мешаем работе самого подкаталога
    }
  }
}

/** Информация о пути через lstat (не следует symlink). Бросает ошибки fs как есть. */
export type PathStat = {
  /** путь — символическая ссылка */
  symlink: boolean;
  /** путь — обычный файл */
  regular: boolean;
  size: number;
  mode: number;
};

export function inspectPath(path: string): PathStat {
  const st = lstatSync(path);
  return { symlink: st.isSymbolicLink(), regular: st.isFile(), size: st.size, mode: st.mode };
}

/** Информация о пути с переходом по symlink (stat). Бросает ошибки fs как есть. */
export function inspectPathFollow(path: string): PathStat {
  const st = statSync(path);
  return { symlink: false, regular: st.isFile(), size: st.size, mode: st.mode };
}

/** Есть ли у файла/каталога права для group/other (шире приватных)? */
export function hasWideMode(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

/**
 * Точки инъекции сбоев для тестов атомарной записи (ревью 164 m10): ESM-namespace
 * node:fs не патчится, поэтому тесты подменяют реализации здесь. Продовый код
 * эти поля не трогает; по умолчанию — системные функции.
 */
export const fsWriteCalls: {
  writeSync: typeof writeSync;
  renameSync: typeof renameSync;
} = { writeSync, renameSync };

/**
 * Атомарная приватная запись: отказ при цели-symlink или не-обычном файле,
 * tmp в том же каталоге (0600) + rename, права конечного файла 0600 (в том
 * числе для перезаписанного файла с широкими правами). При сбое tmp удаляется.
 * Каталог должен существовать (внутренние — через ensurePrivateDir); запись в
 * несуществующий каталог не создаёт его, а отдаёт ошибку вызывающему.
 */
export function writePrivateFile(path: string, data: string | Buffer): void {
  const dir = dirname(path);
  // lstat-проверка вместо O_NOFOLLOW: отказ на symlink и не-обычную цель до записи.
  try {
    const st = inspectPath(path);
    if (st.symlink) {
      throw new McpError("INVALID_ARGUMENT", `путь назначения — символическая ссылка, запись отклонена: ${basename(path)}`);
    }
    if (!st.regular) {
      throw new McpError("INVALID_ARGUMENT", `путь назначения не является обычным файлом: ${basename(path)}`);
    }
  } catch (e) {
    if (e instanceof McpError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  // Ревью 164 m5: имя tmp с криптослучайной частью — не предсказать и не подставить.
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | null = null;
  let created = false;
  try {
    fd = openSync(tmp, "wx", PRIVATE_FILE_MODE);
    created = true;
    let offset = 0;
    while (offset < buf.length) {
      offset += fsWriteCalls.writeSync(fd, buf, offset, buf.length - offset);
    }
    closeSync(fd);
    fd = null;
    chmodSync(tmp, PRIVATE_FILE_MODE);
    fsWriteCalls.renameSync(tmp, path);
    // rename подменяет существующий файл целиком, но на случай внешних прав — chmod.
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch (e) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* уже закрыт */ }
    }
    // Ревью 164 m5: unlink только tmp, созданного этим вызовом, — чужой файл
    // с тем же именем (EEXIST) не удаляется.
    if (created) {
      try { unlinkSync(tmp); } catch { /* tmp уже удалён */ }
    }
    throw e;
  }
}

/** Имя tmp-файла writePrivateFile (для тестов атомарности: tmp не остаётся). */
export function tmpFilePrefix(name: string): string {
  return `.${name}.`;
}
