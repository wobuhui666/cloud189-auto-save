import { AUTH_ENDPOINTS } from "./endpoints";
import { base64EncodeUtf8 } from "./base64";

export const SERVER_ACTIONS = {
  login: {
    id: AUTH_ENDPOINTS.serverActionLoginId,
    name: AUTH_ENDPOINTS.serverActionLoginName
  },
  encryptQuery: {
    id: "40049854b309aa8ea669ee527cfcad9cf28dcb5c78",
    name: "encrypte"
  },
  decryptQuery: {
    id: "40de767e3029b7ee7ad7d9eb43ebd59a07971d91e8",
    name: "decrypt"
  },
  resourceUnlock: {
    id: "601a2054beb3034dd490287f5aa0d7c801f9e650c7",
    name: "resourceUnlock"
  }
} as const;

export interface LoginActionPayload {
  username: string;
  password: string;
  password_transport: "base64";
}

export function buildLoginActionPayload(username: string, password: string): LoginActionPayload {
  return {
    username,
    password: base64EncodeUtf8(password),
    password_transport: "base64"
  };
}

export interface TmdbProxyQuery {
  endpoint: string;
  query?: string;
  language?: string;
  page?: number;
  utctimestamp: number;
  [key: string]: string | number | boolean | undefined;
}

export interface TmdbProxyQueryInput {
  endpoint: string;
  query?: string;
  language?: string;
  page?: number;
  [key: string]: string | number | boolean | undefined;
}

export function buildTmdbProxyQuery(input: TmdbProxyQueryInput): TmdbProxyQuery {
  return {
    language: "zh-CN",
    ...input,
    utctimestamp: Math.floor(Date.now() / 1000)
  };
}

export type ResourceUnlockActionPayload = [resourceSlug: string, formToken: "$T"];

export function buildResourceUnlockActionPayload(resourceSlug: string): ResourceUnlockActionPayload {
  return [resourceSlug, "$T"];
}
