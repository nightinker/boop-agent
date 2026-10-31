# Headless Boop server for Linux hosts. See docs/DEPLOY-VPS.md ("Docker").
# Needs convex/_generated (run `npx convex dev --once` on the host first) and
# a .env.local passed in by docker-compose.yml. Apple data and the local
# browser are macOS-only and stay off inside the container.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm install -g @anthropic-ai/claude-code --no-audit --no-fund \
  && npm cache clean --force

COPY . .
RUN mkdir -p /app/data /home/node/.claude \
  && chown -R node:node /app /home/node

USER node
ENV PORT=3456
EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3456)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "node scripts/preflight.mjs && exec node node_modules/tsx/dist/cli.mjs server/index.ts"]
