import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { McpError } from "./errors.ts";

// B4 (аудит 65): единая граница файловых операций — каталоги состояния 0700,
// файлы с планами/сессиями/бэкапами/рендерами 0600, запись атомарная
// (tmp в том же каталоге + rename), существующие широкие права чинятся chmod.

/** Права каталогов состояния (HOME_DIR и подкаталоги). */
export const PRIVATE_DIR_MODE = 0o700;
/** Права файлов с приватным содержимым (план, сессия, бэкап, кэш каталога, PNG). */
export const PRIVATE_FILE_MODE = 0o600;

/** Создать каталог (рекурсивно) и гарантировать 0700 — в том числе для существующего. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // mkdirSync не чинит права уже существующего каталога — chmod явно.
  chmodSync(dir, PRIVATE_DIR_MODE);
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

/** Есть ли у файла/каталога права для group/other (шире приватных)? */
export function hasWideMode(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

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
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", PRIVATE_FILE_MODE);
    let offset = 0;
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    }
    closeSync(fd);
    fd = null;
    chmodSync(tmp, PRIVATE_FILE_MODE);
    renameSync(tmp, path);
    // rename подменяет существующий файл целиком, но на случай внешних прав — chmod.
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch (e) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* уже закрыт */ }
    }
    try { unlinkSync(tmp); } catch { /* tmp мог не создаться */ }
    throw e;
  }
}

/** Имя tmp-файла writePrivateFile (для тестов атомарности: tmp не остаётся). */
export function tmpFilePrefix(name: string): string {
  return `.${name}.`;
}
