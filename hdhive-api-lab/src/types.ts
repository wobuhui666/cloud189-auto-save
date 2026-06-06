export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export interface ApiEnvelope<T = unknown> {
  success?: boolean;
  code?: string;
  message?: string;
  description?: string;
  data?: T;
  error?: unknown;
}

export interface RequestOptions {
  method?: HttpMethod;
  headers?: HeadersInit;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  skipRefresh?: boolean;
}

export interface ApiResponse<T = unknown> {
  status: number;
  statusText: string;
  headers: Headers;
  data: T;
}

export interface HdhiveClientOptions {
  baseUrl?: string;
  cookie?: string;
  csrfToken?: string;
  userAgent?: string;
}

export interface SecureSession {
  cid: string;
  expiresAt: number;
}
