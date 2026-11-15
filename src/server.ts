import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ServerContext } from "./server/context.ts";
import { projectTools } from "./server/tools-projects.ts";
import { planTools } from "./server/tools-plan.ts";

// T18: MCP-сервер (stdio, @modelcontextprotocol/sdk). Регистрация всех инструментов.

export const SERVER_INFO = { name: "remplanner", version: "0.1.0" } as const;

/** Собрать сервер со всеми инструментами (для serve и smoke-тестов). */
export function buildServer(ctx: ServerContext): McpServer {
  const server = new McpServer(SERVER_INFO);
  const defs = { ...projectTools(ctx), ...planTools(ctx) };
  for (const [name, def] of Object.entries(defs)) {
    server.registerTool(name, { description: def.description, inputSchema: def.inputSchema }, def.handler);
  }
  return server;
}

/** Запуск по stdio (design §11). Сеть и Chrome — только вне песочницы. */
export async function serve(): Promise<void> {
  const offlineFixture = process.env["REMPLANNER_OFFLINE_FIXTURE"];
  const ctx = new ServerContext({ offlineFixture });
  const server = buildServer(ctx);
  await server.connect(new StdioServerTransport());
  // stdout занят протоколом MCP — служебные сообщения только в stderr
  console.error(`remplanner-mcp ${SERVER_INFO.version}: serving on stdio (mode: ${ctx.mode})`);
}
