import { CookieJar } from "./cookieJar";
import { HDHIVE_BASE_URL, AUTH_ENDPOINTS, normalizeApiPath } from "./endpoints";
import type { ApiResponse, HdhiveClientOptions, RequestOptions } from "./types";

export class HdhiveClient {
  private readonly baseUrl: string;
  private readonly jar: CookieJar;
  private readonly userAgent: string;
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(options: HdhiveClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? HDHIVE_BASE_URL;
    this.jar = new CookieJar(options.cookie);
    this.userAgent = options.userAgent ?? "Mozilla/5.0 HDHiveApiLab/0.1";

    if (options.csrfToken) {
      this.jar.seed(`csrf_access_token=${options.csrfToken}`);
    }
  }

  get cookies(): CookieJar {
    return this.jar;
  }

  async get<T = unknown>(path: string, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<ApiResponse<T>> {
    return this.request<T>(path, { ...options, method: "GET" });
  }

  async post<T = unknown>(path: string, body?: unknown, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<ApiResponse<T>> {
    return this.request<T>(path, { ...options, method: "POST", body });
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const first = await this.rawRequest<T>(path, options);
    const code = getEnvelopeCode(first.data);

    if (first.status !== 401 || options.skipRefresh || code === "missing_signature") {
      return first;
    }

    const refreshed = await this.refreshAuth();
    if (!refreshed) return first;

    return this.rawRequest<T>(path, {
      ...options,
      headers: {
        ...headerInitToObject(options.headers),
        "x-skip-auth-refresh": "true"
      },
      skipRefresh: true
    });
  }

  async refreshAuth(): Promise<boolean> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.rawRequest(AUTH_ENDPOINTS.refresh, {
        method: "POST",
        headers: { "x-skip-auth-refresh": "true" },
        skipRefresh: true
      })
        .then((response) => response.status >= 200 && response.status < 300)
        .catch(() => false)
        .finally(() => {
          this.refreshInFlight = null;
        });
    }

    return this.refreshInFlight;
  }

  private async rawRequest<T = unknown>(path: string, options: RequestOptions): Promise<ApiResponse<T>> {
    const method = options.method ?? "GET";
    const url = this.toUrl(path, options.query);
    const headers = new Headers(options.headers);
    headers.set("accept", "application/json, text/plain, */*");
    headers.set("user-agent", this.userAgent);

    const cookieHeader = this.jar.toHeader();
    if (cookieHeader) headers.set("cookie", cookieHeader);

    const csrfToken = this.jar.get("csrf_access_token");
    if (csrfToken) headers.set("X-CSRF-TOKEN", csrfToken);

    let body: BodyInit | undefined;
    if (options.body !== undefined && method !== "GET" && method !== "HEAD") {
      if (typeof options.body === "string" || options.body instanceof URLSearchParams || options.body instanceof Blob) {
        body = options.body;
      } else {
        headers.set("content-type", headers.get("content-type") ?? "application/json");
        body = JSON.stringify(options.body);
      }
    }

    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: options.signal
    });

    this.jar.setFromHeaders(response.headers);
    const data = (await readResponseBody(response)) as T;

    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data
    };
  }

  private toUrl(path: string, query?: RequestOptions["query"]): URL {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === null || value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }
}

export function getSignaturePath(path: string): string {
  return normalizeApiPath(new URL(path, HDHIVE_BASE_URL).pathname);
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;

  const text = await response.text();
  if (!text) return "";

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getEnvelopeCode(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const maybeCode = (data as { code?: unknown }).code;
  return typeof maybeCode === "string" ? maybeCode : undefined;
}

function headerInitToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}
