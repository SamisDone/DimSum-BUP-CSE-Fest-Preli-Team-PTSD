# GridWise API — Bun runtime image.
# Owned by role A. See ACTION_PLAN.md §"A — Service & Deployment" / Category 6.
#
# No secrets are baked in: GEMINI_API_KEY (and any other credential) is read
# from the environment at runtime only. See .env.example for the full list.

FROM oven/bun:1-slim

WORKDIR /app

# Install dependencies first so this layer is cached across source-only changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY web/ ./web/
# CI smoke test: this comment is a no-op push to confirm docker-publish.yml
# fires and publishes on a direct push to main, not just a PR merge.

ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

# Runs as the non-root "bun" user baked into the base image.
USER bun

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
