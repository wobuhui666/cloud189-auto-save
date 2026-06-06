export const HDHIVE_BASE_URL = "https://hdhive.com";

export const UNSIGNED_PREFIXES = [
  "/api/public/security/session/handshake",
  "/api/public/security/session/refresh",
  "/api/public/security/decoy",
  "/api/public/security/time",
  "/api/open/",
  "/api/public/auth/",
  "/api/public/auth/telegram/",
  "/api/miniapp/"
] as const;

export const AUTH_ENDPOINTS = {
  refresh: "/api/public/auth/refresh",
  telegram: "/api/public/auth/telegram/",
  serverActionLoginName: "login",
  serverActionLoginId: "60a8e51aa9fa16f01cbaad3b32b28805276693cc21"
} as const;

export const SECURITY_ENDPOINTS = {
  time: "/api/public/security/time",
  handshake: "/api/public/security/session/handshake",
  refreshSession: "/api/public/security/session/refresh",
  decoy: "/api/public/security/decoy"
} as const;

export const GO_API_ENDPOINTS = {
  appSettings: "/go-api/public/app-settings",
  latestBulletin: "/go-api/public/bulletins/latest",
  tmdbSearchMulti: "/go-api/proxy/tmdb/3/search/multi",
  tmdbSearchMovie: "/go-api/proxy/tmdb/3/search/movie",
  tmdbSearchTv: "/go-api/proxy/tmdb/3/search/tv",
  tmdbMovieById: (tmdbId: string | number) => `/go-api/proxy/tmdb/3/movie/${tmdbId}`,
  tmdbTvById: (tmdbId: string | number) => `/go-api/proxy/tmdb/3/tv/${tmdbId}`
} as const;

export const CUSTOMER_ENDPOINTS = {
  currentUser: "/api/customer/user/current",
  checkin: "/api/customer/user/checkin",
  pointsLogs: "/api/customer/points-logs",
  changePassword: "/api/customer/user/change-password",
  redeemVip: "/api/customer/vip/redeem",
  resources: "/api/customer/resources",
  checkResource: "/api/customer/check/resource",
  resourceById: (resourceId: string | number) => `/api/customer/resources/${resourceId}`,
  resourcesNotify: "/api/customer/resources/notify",
  resourceUnlock: (resourceId: string | number) => `/api/customer/resources/${resourceId}/unlock`,
  musicResourceUnlock: (resourceId: string | number) => `/api/customer/music_resources/${resourceId}/unlock`,
  tvPackUnlock: (packId: string | number) => `/api/customer/tv-follow/packs/${packId}/unlock`
} as const;

export const RESPONSE_SIGNATURE_REQUIRED_EXACT = [
  CUSTOMER_ENDPOINTS.checkin,
  "/api/customer/user/change-email/send-current-code",
  "/api/customer/user/change-email/verify-current-code",
  "/api/customer/user/change-email",
  CUSTOMER_ENDPOINTS.changePassword,
  CUSTOMER_ENDPOINTS.redeemVip,
  CUSTOMER_ENDPOINTS.currentUser,
  CUSTOMER_ENDPOINTS.pointsLogs
] as const;

export const RESPONSE_SIGNATURE_REQUIRED_PATTERNS = [
  { prefix: "/api/customer/resources/", suffix: "/unlock" },
  { prefix: "/api/customer/music_resources/", suffix: "/unlock" },
  { prefix: "/api/customer/tv-follow/packs/", suffix: "/unlock" }
] as const;

export function normalizeApiPath(path: string): string {
  return path.startsWith("/go-api/") ? `/api/${path.slice("/go-api/".length)}` : path;
}

export function isUnsignedPath(path: string): boolean {
  const normalizedPath = normalizeApiPath(path);
  return normalizedPath.startsWith("/api/") && UNSIGNED_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix));
}

export function requiresResponseSignature(path: string): boolean {
  const normalizedPath = normalizeApiPath(path);

  if (RESPONSE_SIGNATURE_REQUIRED_EXACT.some((exact) => normalizedPath === exact || normalizedPath.startsWith(`${exact}/`))) {
    return true;
  }

  return RESPONSE_SIGNATURE_REQUIRED_PATTERNS.some(({ prefix, suffix }) => {
    if (!normalizedPath.startsWith(prefix) || !normalizedPath.endsWith(suffix)) return false;
    const idPart = normalizedPath.slice(prefix.length, normalizedPath.length - suffix.length);
    return idPart.length > 0 && !idPart.includes("/");
  });
}
