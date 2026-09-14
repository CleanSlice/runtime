FROM oven/bun:1.3-alpine AS base
WORKDIR /app

# System packages: browser, CLI tools, networking, scripting
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
    git \
    python3 \
    py3-pip

# Spreadsheet parsing for files the agent fetched ITSELF — from an ERP over
# curl, the browser tools, an MCP server. Chat attachments are a different
# path: those are parsed server-side and read back through Ranch's
# `query_attachment`, which resolves an id in the bridle attachment store and
# therefore cannot see a file the agent downloaded on its own.
#
# --break-system-packages is required, not cosmetic: Alpine marks the system
# python as externally managed (PEP 668), so a plain `pip3 install` fails the
# build with "error: externally-managed-environment".
#
# Installed here rather than left to the agent: `pip install` at runtime lands
# in /home/agent/.local and is lost on the next container restart.
#
# Pinned so a rebuild cannot silently change the parser. openpyxl pulls only
# et-xmlfile; `apk add py3-openpyxl` would drag in pandas and pillow (59
# packages, 194 MiB against 66 MiB for this route).
RUN pip3 install --no-cache-dir --break-system-packages openpyxl==3.1.5

# Use system Chromium — skip Playwright's own browser download
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
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
