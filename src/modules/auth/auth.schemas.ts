import { z } from "zod";

// ────────────────────────────────────────────────────────────────────
// Request schemas for the auth endpoints.
//
// Zod runs inside our zValidator wrapper, so a failure comes back in
// the canonical error body with the offending field's path.
// ────────────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  email: z.email().max(254),
  
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(100),
});

export const loginSchema = z.object({
  email: z.email().max(254),
  
  password: z.string().min(1).max(128),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
