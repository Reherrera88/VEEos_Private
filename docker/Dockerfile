# VEEos - Multi-account Google Flow Pool
# Build: docker build -t veeos:latest -f docker/Dockerfile .
# Run: docker run -d --name veeos -p 3456:3456 -p 9222-9240:9222-9240 -v /home/user/.config/google-chrome:/host-chrome:ro -v veeos-data:/data veeos:latest

FROM node:20-bookworm-slim

# Install dependencies for Chrome and Playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libwayland-client0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    libu2f-udev \
    libvulkan1 \
    && rm -rf /var/lib/apt/lists/*

# Install Google Chrome Stable
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Verify Chrome installation
RUN google-chrome-stable --version

# Create app user
RUN groupadd -r veeos && useradd -r -g veeos -G audio,video -m -d /home/veeos -s /bin/bash veeos

# Set up working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm ci --only=production && npm cache clean --force

# Install Playwright browsers (chromium only, using system Chrome)
RUN npx playwright install-deps chromium 2>/dev/null || true
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npx playwright install chromium 2>/dev/null || true

# Copy application code
COPY src/ ./src/
COPY config/ ./config/

# Create data directories
RUN mkdir -p /data/screenshots /data/downloads /data/logs && chown -R veeos:veeos /data

# Switch to non-root user
USER veeos

# Environment variables
ENV NODE_ENV=production \
    VEEOS_CONFIG=/app/config/local.yaml \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Expose ports
EXPOSE 3456 9222 9223 9224 9225 9226 9227 9228 9229 9230 9231 9232 9233 9234 9235 9236 9237 9238 9239 9240

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3456/health || exit 1

# Entry point
ENTRYPOINT ["node", "src/index.js"]