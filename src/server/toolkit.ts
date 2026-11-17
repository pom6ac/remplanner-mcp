import { z } from "zod";
import { errorToPayload, type ErrorCode } from "../errors.ts";
import { jsonText } from "./context.ts";

// Общие помощники MCP-инструментов: формат ответа и обработка ошибок (design §8).

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type ToolResult = { content: Content[]; isError?: boolean };

export type ToolDefLike = {
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

export function ok(value: unknown, extra?: Content[]): ToolResult {
  const content: Content[] = [{ type: "text", text: jsonText(value) }];
  return { content: extra ? [...extra, ...content] : content };
}

/** Единая безопасная сериализация (этап 145, B2): McpError — как есть (маскируется), неожиданные исключения — нейтральные. */
export function jsonError(e: unknown): ToolResult {
  return { isError: true, content: [{ type: "text", text: jsonText(errorToPayload(e)) }] };
}

/** Обёртка: описание + zod-схема + обработчик с единым маппингом ошибок. */
export function tool(
  description: string,
  inputSchema: Record<string, z.ZodType>,
  handler: (args: Record<string, unknown>) => Promise<ToolResult>,
): ToolDefLike {
  return {
    description,
    inputSchema,
    handler: async (args) => {
      try {
        return await handler(args);
      } catch (e) {
        return jsonError(e);
      }
    },
  };
}
