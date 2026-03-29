FROM oven/bun:1.3-alpine AS base
WORKDIR /app

# System packages: browser, CLI tools, networking
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-emoji \
    openssh-client \
    curl \
    jq \
    bash \
    git

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Install dependencies (cached layer)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY . .

# Create agent directory with correct ownership
RUN adduser -D -u 1001 agent \
    && mkdir -p .agent/data/sessions .agent/data/secrets .agent/skills .agent/workspace \
    && chown -R agent:agent .agent

# Run as non-root
USER agent

# Health check — hits the built-in HTTP server
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
    CMD curl -sf http://localhost:3000/ || exit 1

# MULTI=true → multi-agent mode, default → single agent
ENV MULTI=false

CMD ["sh", "-c", "if [ \"$MULTI\" = 'true' ]; then bun run --smol src/multi.ts; else bun run --smol src/index.ts; fi"]
