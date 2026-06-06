export class CookieJar {
  private readonly cookies = new Map<string, string>();

  constructor(cookieHeader?: string) {
    if (cookieHeader) {
      this.seed(cookieHeader);
    }
  }

  seed(cookieHeader: string): void {
    for (const part of cookieHeader.split(";")) {
      const [name, ...valueParts] = part.trim().split("=");
      if (!name || valueParts.length === 0) continue;
      this.cookies.set(name, valueParts.join("="));
    }
  }

  setFromHeaders(headers: Headers): void {
    const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
    const values = typeof getSetCookie === "function" ? getSetCookie.call(headers) : splitSetCookieHeader(headers.get("set-cookie"));

    for (const value of values) {
      const [pair] = value.split(";");
      if (!pair) continue;
      const [name, ...valueParts] = pair.trim().split("=");
      if (!name || valueParts.length === 0) continue;
      this.cookies.set(name, valueParts.join("="));
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  delete(name: string): void {
    this.cookies.delete(name);
  }

  toHeader(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

function splitSetCookieHeader(header: string | null): string[] {
  if (!header) return [];

  const result: string[] = [];
  let start = 0;
  let inExpires = false;

  for (let index = 0; index < header.length; index += 1) {
    const chunk = header.slice(index, index + 8).toLowerCase();
    if (chunk === "expires=") {
      inExpires = true;
      index += 7;
      continue;
    }

    if (inExpires && header[index] === ";") {
      inExpires = false;
      continue;
    }

    if (!inExpires && header[index] === ",") {
      result.push(header.slice(start, index).trim());
      start = index + 1;
    }
  }

  const tail = header.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}
