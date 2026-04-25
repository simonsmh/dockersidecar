FROM node:24-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# /opt/tools：全局只读工具目录，任意 UID 可执行
ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/tmp/.playwright-browsers \
    PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    PIP_TRUSTED_HOST=mirrors.aliyun.com \
    UV_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    npm_config_registry=https://registry.npmmirror.com \
    TOOLS_DIR=/opt/tools

# ---------- 系统依赖 + Playwright ----------
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
        sed -i 's|security.debian.org/debian-security|mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list.d/debian.sources; \
    elif [ -f /etc/apt/sources.list ]; then \
        sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list; \
        sed -i 's|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        ffmpeg \
        git \
        jq \
        openssh-client \
        python3 \
        python3-pip \
        ripgrep \
        sudo \
        unzip \
        zip \
    ; \
    echo "ALL ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/nopasswd && chmod 0440 /etc/sudoers.d/nopasswd; \
    npm install -g playwright; \
    npm install -g @qoder-ai/qodercli; \
    npm install -g @anthropic-ai/claude-code; \
    npm install -g @zed-industries/claude-agent-acp; \
    npm install -g @mariozechner/pi-coding-agent; \
    npm install -g pi-acp; \
    npm install -g pi-mcp-adapter; \
    npm cache clean --force; \
    npx playwright install-deps chromium; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    mkdir -p "${TOOLS_DIR}"; \
    curl --proto '=https' --tlsv1.2 -LsSf https://astral.sh/uv/install.sh | sh; \
    curl -fsSL https://cursor.com/install | bash; \
    curl -fsSL https://cli.kiro.dev/install | bash

RUN mv /root/.local "${TOOLS_DIR}/.local"; \
    ln -sf "${TOOLS_DIR}/.local/share/cursor-agent/versions"/*/cursor-agent "${TOOLS_DIR}/.local/bin/agent"; \
    ln -sf "${TOOLS_DIR}/.local/share/cursor-agent/versions"/*/cursor-agent "${TOOLS_DIR}/.local/bin/cursor-agent"; \
    chmod -R a+rX "${TOOLS_DIR}"; \
    echo "=== Installed tools ==="; \
    ls -la "${TOOLS_DIR}/.local/bin/"

ENV PATH="${TOOLS_DIR}/.local/bin:${PATH}"

# ---------- ACP Sidecar ----------
COPY acp-sidecar.js /usr/local/bin/acp-sidecar.js

EXPOSE 3000

USER 1000:1000
ENTRYPOINT ["node", "/usr/local/bin/acp-sidecar.js"]
