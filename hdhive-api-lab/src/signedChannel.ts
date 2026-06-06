import { randomBytes } from "node:crypto";
import { normalizeApiPath, requiresResponseSignature, SECURITY_ENDPOINTS } from "./endpoints";
import type { SecureSession } from "./types";

export interface HdhiveWasmSigner {
  init(): Uint8Array;
  finalizeHandshake(cid: string, serverPub: Uint8Array, kid: number): void;
  signRequest(method: string, path: string, timestamp: string, nonce: string, body: Uint8Array, userId: string): string;
  verifyResponse(path: string, status: number, responseTimestamp: string, body: Uint8Array, responseSignature: string): boolean;
}

export interface SignedHeaderOptions {
  signer: HdhiveWasmSigner;
  session: SecureSession;
  method: string;
  path: string;
  body?: Uint8Array;
  userId?: string;
  clockSkewMs?: number;
}

export function buildSignedHeaders(options: SignedHeaderOptions): Record<string, string> {
  const body = options.body ?? new Uint8Array();
  const path = normalizeApiPath(options.path);
  const timestamp = String(Date.now() + (options.clockSkewMs ?? 0));
  const nonce = randomBytes(16).toString("hex");
  const userId = options.userId ?? "0";
  const signature = options.signer.signRequest(options.method.toUpperCase(), path, timestamp, nonce, body, userId);

  return {
    "X-HDH-Cid": options.session.cid,
    "X-HDH-TS": timestamp,
    "X-HDH-Nonce": nonce,
    "X-HDH-Sig": signature,
    "X-HDH-Kid": "1"
  };
}

export async function verifySignedResponse(
  signer: HdhiveWasmSigner,
  path: string,
  response: Response
): Promise<Response> {
  const normalizedPath = normalizeApiPath(path);
  const responseSignature = response.headers.get("X-HDH-RSig");

  if (!responseSignature) {
    if (requiresResponseSignature(normalizedPath)) {
      await response.arrayBuffer().catch(() => undefined);
      throw new Error(`Missing X-HDH-RSig for signed response path: ${normalizedPath}`);
    }
    return response;
  }

  const responseTimestamp = response.headers.get("X-HDH-RTS") ?? "";
  const buffer = await response.arrayBuffer();
  const body = new Uint8Array(buffer);
  const valid = signer.verifyResponse(normalizedPath, response.status, responseTimestamp, body, responseSignature);
  if (!valid) {
    throw new Error(`Invalid X-HDH-RSig for path: ${normalizedPath}`);
  }

  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return new Response(copy, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

export async function readServerTime(baseUrl = "https://hdhive.com"): Promise<number> {
  const response = await fetch(new URL(SECURITY_ENDPOINTS.time, baseUrl));
  if (!response.ok) {
    throw new Error(`Server time request failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as { data?: { server_time_ms?: number } };
  const serverTime = data.data?.server_time_ms;
  if (typeof serverTime !== "number" || !Number.isFinite(serverTime)) {
    throw new Error("Server time response does not include data.server_time_ms.");
  }

  return serverTime;
}

export function createMissingSignerError(path: string): Error {
  return new Error(
    `Path ${normalizeApiPath(path)} requires HDHive's browser WASM signer. ` +
      "This lab records the call boundary, but does not bypass or reimplement the production signer."
  );
}
