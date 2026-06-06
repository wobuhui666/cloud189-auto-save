FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY browser-bridge/package.json browser-bridge/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY browser-bridge/server.mjs ./

EXPOSE 10000

CMD ["node", "server.mjs"]
