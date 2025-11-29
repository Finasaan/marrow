import { Context } from "hono";

/**
 * Application context type with Cloudflare bindings
 */
export type AppContext = Context<{ Bindings: CloudflareBindings }>;

/**
 * Standard API response format
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

/**
 * Paginated API response format
 */
export interface PaginatedApiResponse<T = unknown> extends ApiResponse<T> {
  pagination?: {
    limit: number;
    offset: number;
    total: number | null;
  };
}

/**
 * Standard error response helper
 */
export function errorResponse(error: unknown): {
  success: false;
  error: string;
} {
  return {
    success: false,
    error: error instanceof Error ? error.message : "Unknown error",
  };
}

/**
 * Standard success response helper
 */
export function successResponse<T>(data: T): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Paginated success response helper
 */
export function paginatedResponse<T>(
  data: T,
  pagination: { limit: number; offset: number; total: number | null }
): PaginatedApiResponse<T> {
  return {
    success: true,
    data,
    pagination,
    timestamp: new Date().toISOString(),
  };
}
