import { HdhiveClient } from "./hdhiveClient";
import { GO_API_ENDPOINTS, SECURITY_ENDPOINTS, CUSTOMER_ENDPOINTS, isUnsignedPath, normalizeApiPath } from "./endpoints";
import { SERVER_ACTIONS, buildLoginActionPayload, buildTmdbProxyQuery } from "./serverActions";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const client = new HdhiveClient({
    baseUrl: process.env.HDHIVE_BASE_URL,
    cookie: process.env.HDHIVE_COOKIE,
    csrfToken: process.env.HDHIVE_CSRF_TOKEN
  });

  switch (command ?? "help") {
    case "time": {
      const response = await client.get(SECURITY_ENDPOINTS.time);
      printJson(response.data);
      return;
    }

    case "probe": {
      const path = args[0] ?? SECURITY_ENDPOINTS.time;
      const response = await client.get(path);
      printJson({
        path,
        normalizedPath: normalizeApiPath(path),
        unsignedByBrowserAdapter: isUnsignedPath(path),
        status: response.status,
        data: response.data
      });
      return;
    }

    case "shapes": {
      printJson({
        serverActions: SERVER_ACTIONS,
        goApi: GO_API_ENDPOINTS,
        customer: CUSTOMER_ENDPOINTS,
        tmdbProxyQueryExample: buildTmdbProxyQuery({
          endpoint: GO_API_ENDPOINTS.tmdbSearchMulti,
          query: "akira",
          page: 1
        }),
        loginActionPayloadExample: buildLoginActionPayload("user@example.com", "password-placeholder")
      });
      return;
    }

    default:
      printHelp();
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node dist/cli.js time
  node dist/cli.js probe /api/public/security/time
  node dist/cli.js shapes

Environment:
  HDHIVE_BASE_URL=https://hdhive.com
  HDHIVE_COOKIE='browser exported cookie header'
  HDHIVE_CSRF_TOKEN='csrf_access_token value'
`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
