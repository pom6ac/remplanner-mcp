import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { ensurePrivateDir, hasWideMode, inspectPath, inspectPathFollow, ownedByCurrentUser } from "./fs-safe.ts";
import { McpError } from "./errors.ts";

export type Credentials = {
  login: string;
  password: string;
};

/** Маскирование значения для сообщений об ошибках: не раскрывает содержимое. */
export function maskValue(value: string): string {
  if (value.length <= 2) return "***";
  return `${value.slice(0, 1)}***${value.slice(-1)}`;
}

/** Парсер env-файла: `KEY=value`, кавычки, комментарии `#`, пустые строки. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key !== "") out[key] = value;
  }
  return out;
}

/** Права файла: true, если только владелец (0600). */
export function isPrivateMode(filePath: string): boolean {
  return (inspectPath(filePath).mode & 0o777) === 0o600;
}

/**
 * B4 (аудит 65): права файла и каталога проверяются ДО чтения. Широкие права
 * (group/other) файла — отказ с подсказкой chmod; каталог текущего пользователя
 * чинится chmod 700 (ревью 164 m2), чужой владелец — отказ. Содержимое файла в
 * ошибку не попадает. Symlink-файл тоже отклоняется. На Windows и ФС без
 * достоверных POSIX-прав проверка режима не выполняется (ревью 164 M1):
 * разовое предупреждение вместо отказа.
 */
/** Режимы POSIX достоверны не везде: на win32 lstat().mode файла всегда 0666. */
const POSIX_MODES = process.platform !== "win32";
let warnedNonPosix = false;

function warnNonPosixOnce(filePath: string): void {
  if (warnedNonPosix) return;
  warnedNonPosix = true;
  console.error(
    `предупреждение: ${filePath}: проверка прав 0600/0700 пропущена — платформа/ФС без достоверных POSIX-прав`,
  );
}

function assertPrivateStorage(filePath: string): void {
  let fileStat;
  try {
    fileStat = inspectPath(filePath);
  } catch {
    throw new McpError("AUTH_REQUIRED", `нет файла учётных данных ${filePath}`, {
      hint: "создайте файл с REMPLANNER_LOGIN и REMPLANNER_PASSWORD (права 0600)",
    });
  }
  if (fileStat.symlink) {
    throw new McpError("AUTH_REQUIRED", `${filePath}: файл учётных данных — символическая ссылка, отказ`, {
      hint: `положите обычный файл с правами 0600 (chmod 600 ${filePath})`,
    });
  }
  if (!POSIX_MODES) {
    warnNonPosixOnce(filePath);
    return;
  }
  if (hasWideMode(fileStat.mode)) {
    const mode = (fileStat.mode & 0o777).toString(8);
    throw new McpError("AUTH_REQUIRED", `${filePath}: права файла шире 0600 (${mode}), доступ группы/других — отказ`, {
      hint: `chmod 600 ${filePath}`,
    });
  }
  // Ревью 164 m1: каталог проверяется по realpath — symlink-каталог 0700 не отказ,
  // подсказка chmod даётся с реальным путём каталога.
  let dirPath = dirname(filePath);
  try {
    dirPath = realpathSync(dirPath);
  } catch {
    return; // каталог исчез между проверками — ошибка чтения ниже
  }
  let dirStat;
  try {
    dirStat = inspectPathFollow(dirPath);
  } catch {
    return; // каталог исчез между проверками — ошибка чтения ниже
  }
  if (hasWideMode(dirStat.mode)) {
    // Ревью 164 m2: каталог текущего пользователя чинится (chmod 700), отказ —
    // только для чужого владельца.
    if (!ownedByCurrentUser(dirPath)) {
      throw new McpError("AUTH_REQUIRED", `каталог ${dirPath} принадлежит другому пользователю — отказ`, {
        hint: "положите учётные данные в каталог своего пользователя с правами 0700",
      });
    }
    ensurePrivateDir(dirPath);
  }
}

export function readCredentials(filePath: string): Credentials {
  assertPrivateStorage(filePath);
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    throw new McpError("AUTH_REQUIRED", `нет файла учётных данных ${filePath}`, {
      hint: "создайте файл с REMPLANNER_LOGIN и REMPLANNER_PASSWORD (права 0600)",
    });
  }
  const env = parseEnvFile(text);
  const login = env["REMPLANNER_LOGIN"] ?? "";
  const password = env["REMPLANNER_PASSWORD"] ?? "";
  if (login === "" || password === "") {
    throw new McpError("AUTH_REQUIRED", `${filePath}: нет REMPLANNER_LOGIN или REMPLANNER_PASSWORD`);
  }
  return { login, password };
}

/** Убирает значения учётных данных из произвольного текста (логи, ошибки). */
export function scrubSecrets(text: string, credentials?: Credentials): string {
  let out = text;
  if (credentials) {
    if (credentials.login !== "") out = out.replaceAll(credentials.login, "login" + "=***");
    if (credentials.password !== "") out = out.replaceAll(credentials.password, "password" + "=***");
  }
  return out;
}
