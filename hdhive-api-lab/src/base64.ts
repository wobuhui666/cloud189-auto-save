export function base64EncodeUtf8(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function base64DecodeUtf8(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}
