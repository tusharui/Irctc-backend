import { zValidator as honoZValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { z } from "zod";


export interface ApiIssue {
  path: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    message: string;
    issues: ApiIssue[];
  };
}


export function errorBody(message: string, issues: ApiIssue[] = []): ApiErrorBody {
  return { error: { message, issues } };
}

function toIssues(error: unknown): ApiIssue[] {
  const raw = (error as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(raw)) return [];

  return raw.map((issue) => {
    const { path, message } = issue as { path?: unknown; message?: unknown };
    return {
      path: Array.isArray(path) ? path.map(String).join(".") : "",
      message: typeof message === "string" ? message : "Invalid value",
    };
  });
}


export function zValidator<T extends z.ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T
) {
  
  return honoZValidator(target, schema, (result, c) => {
    
    if (!result.success) {
      return c.json(errorBody("Validation failed", toIssues(result.error)), 400);
    }
    return undefined;
  });
}
