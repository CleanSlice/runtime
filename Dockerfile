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

# What a script the agent writes needs to get its job done.
#
# openpyxl — spreadsheet parsing for files the agent fetched ITSELF, from an
# ERP over curl, the browser tools, an MCP server. Chat attachments are a
# different path: those are parsed server-side and read back through Ranch's
# `query_attachment`, which resolves an id in the bridle attachment store and
# therefore cannot see a file the agent downloaded on its own.
#
# requests — the agent reaches for a script whenever a task needs many HTTP
# calls, and it is usually right to: attaching 41 invoice positions to a
# supply is a search plus an add per position, over 80 requests. As individual
# `http` tool calls that is three times maxIterations and pays for a model
# round-trip per request; one script doing the loop is the right shape.
# urllib.request would also do the job, but the model reaches for requests by
# default and arguing with that in every skill costs more than these wheels.
#
# --break-system-packages is required, not cosmetic: Alpine marks the system
# python as externally managed (PEP 668), so a plain `pip3 install` fails the
# build with "error: externally-managed-environment".
#
# Installed here rather than left to the agent: `pip install` at runtime lands
# in /home/agent/.local and is lost on the next container restart, so it works
# once and fails the next day — worse than failing outright.
#
# Pinned so a rebuild cannot silently change either library. openpyxl pulls
# only et-xmlfile; `apk add py3-openpyxl` would drag in pandas and pillow (59
# packages, 194 MiB against 66 MiB for this route). requests pulls urllib3,
# certifi, charset-normalizer and idna — all pure-Python wheels.
RUN pip3 install --no-cache-dir --break-system-packages \
      openpyxl==3.1.5 \
      requests==2.32.3

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
