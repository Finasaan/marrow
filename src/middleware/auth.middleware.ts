import { createMiddleware } from "hono/factory";

/**
 * Auth middleware - validates JWT token from Authorization header
 * For now, this is a placeholder that can be expanded
 */
export const authMiddleware = createMiddleware<{
  Bindings: CloudflareBindings;
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json(
      {
        success: false,
        error: "Unauthorized - Missing or invalid authorization header",
      },
      401
    );
  }

  const token = authHeader.substring(7); // Remove "Bearer " prefix

  // TODO: Validate token with Supabase Auth
  // For now, just check if token exists
  if (!token) {
    return c.json(
      {
        success: false,
        error: "Unauthorized - Invalid token",
      },
      401
    );
  }

  await next();
});

/**
 * Optional auth middleware - doesn't fail if no token, just continues
 */
export const optionalAuthMiddleware = createMiddleware<{
  Bindings: CloudflareBindings;
}>(async (c, next) => {
  // Just continue - token validation can be done in controller if needed
  await next();
});
