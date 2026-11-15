import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpError } from "./errors.ts";
import { STATE_PATH } from "./config.ts";
import { loadSession } from "./session.ts";
import { login } from "./login.ts";
import { checkStatus } from "./api.ts";
import { closeBrowser } from "./browser.ts";

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function cmdLogin(args: string[]): Promise<void> {
  const headed = args.includes("--headed") || process.env["REMPLANNER_HEADED"] === "1";
  try {
    await login({ headed });
    console.log(`вход выполнен, сессия: ${STATE_PATH}`);
  } finally {
    await closeBrowser().catch(() => {});
  }
}

async function cmdCheck(): Promise<void> {
  const session = loadSession(STATE_PATH);
  const info = await checkStatus(session);
  printJson({
    logged_in: info.logged_in,
    tariff: info.tariff,
    projects: info.projects.length,
    project_list: info.projects.map((p) => ({ object_id: p.object_id, title: p.title, version: p.version })),
  });
  if (!info.logged_in) {
    throw new McpError("SESSION_EXPIRED", "сессия не действительна", { hint: "выполните npm run login" });
  }
}

async function cmdServe(): Promise<void> {
  const { serve } = await import("./server.ts");
  await serve();
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case "login":
        await cmdLogin(args);
        break;
      case "check":
        await cmdCheck();
        break;
      case "serve":
        await cmdServe();
        break;
      default:
        printJson({ usage: "node src/cli.ts <serve|login|check|discover>", got: cmd ?? "" });
        process.exitCode = cmd ? 1 : 0;
    }
  } catch (e) {
    if (e instanceof McpError) {
      printJson(e.toJSON());
      process.exitCode = 1;
    } else {
      throw e;
    }
  }
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked !== "" && invoked === thisFile) {
  await main(process.argv.slice(2));
}
