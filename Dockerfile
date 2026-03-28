FROM oven/bun:1.3-alpine AS base
WORKDIR /app

# Install Chromium + deps for Playwright
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-emoji \
    openssh-client

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Install dependencies (cached layer)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY . .

# Create agent directory
RUN mkdir -p .agent/data/sessions .agent/data/secrets

# MULTI=true → multi-agent mode, default → single agent
ENV MULTI=false

CMD ["sh", "-c", "if [ \"$MULTI\" = 'true' ]; then bun run --smol src/multi.ts; else bun run --smol src/index.ts; fi"]
