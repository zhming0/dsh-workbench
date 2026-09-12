# The build stage stays on the native builder architecture and cross-compiles,
# because emulating a Go toolchain under QEMU costs minutes per target.
FROM --platform=$BUILDPLATFORM golang:1.26 AS build
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" \
    go build -trimpath -ldflags='-s -w' -o /dsh-runner ./cmd/dsh-runner

FROM debian:trixie-slim
ARG TARGETARCH
ARG JJ_VERSION=0.44.0
ARG JJ_SHA256_amd64=0a07bab4641a55fd2bc2fd1563ba3a3f9a577584086ad74086a1c5b69b3ffce9
ARG JJ_SHA256_arm64=60d42fa2a9abaa445eff10cd2087458562aaad5a54b90309e5a3787ecc985ff2
ARG MISE_VERSION=2026.8.16
ARG MISE_SHA256_amd64=1445289f35e1a5a7216e1ffee5b34c5b9bd46793224e7e6c335503de9d9df0b2
ARG MISE_SHA256_arm64=21a03117d27028b1b4602bc83d9aefdccd55325ac3da45f7e28c9320627dcdc6
ARG NODE_VERSION=24.19.0
# ripgrep backs the session's `glob` and `grep` search tools: the stock row
# names the host's packaged binary, and the provider's subprocess seam resolves
# `rg` on the runner's PATH in its place.
ARG RIPGREP_VERSION=15.2.0
ARG RIPGREP_SHA256_amd64=33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c
ARG RIPGREP_SHA256_arm64=800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915
ARG UV_VERSION=0.12.9
ARG UV_SHA256_amd64=aa4b1f8770910f7c7c543c7acc980e4270e52e70750c996acef813ea1c7c2912
ARG UV_SHA256_arm64=7eb9bf48516448c9db6a9e436d8e747ac9c8a9cac74717160a29918249b080a6
ARG YQ_VERSION=4.53.6
ARG YQ_SHA256_amd64=c5f056448f973ae7d39b5401949648a78f2dc1947d6a8eb65be60d5c504b9385
ARG YQ_SHA256_arm64=88a1016bc1d657375a35864e4f44b6f333df8ff97b559f51bba0adcb2169df09
# agent-browser backs the `using-agent-browser` skill. Chrome for Testing is
# deliberately installed outside $HOME: the image sets HOME=/workspace/home,
# and a session mounts its workspace volume over /workspace, so a browser under
# $HOME would be hidden at runtime. It is exposed as `google-chrome` on PATH
# instead, a name the CLI searches for itself.
#
# Chrome's shared libraries are installed below by hand. `agent-browser install
# --with-deps` would install the same list, but it shells out to `sudo apt-get`,
# and this image has no sudo and already runs the build as root. The package
# names are the t64 ones Debian trixie uses.
ARG AGENT_BROWSER_VERSION=0.37.1
ARG CHROME_INSTALL_DIR=/opt/agent-browser
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) jj_arch=x86_64-unknown-linux-musl;  mise_arch=linux-x64-musl;   jj_sha="${JJ_SHA256_amd64}"; mise_sha="${MISE_SHA256_amd64}"; rg_arch=x86_64-unknown-linux-musl;  rg_sha="${RIPGREP_SHA256_amd64}"; uv_arch=x86_64-unknown-linux-musl;  uv_sha="${UV_SHA256_amd64}"; yq_sha="${YQ_SHA256_amd64}" ;; \
      arm64) jj_arch=aarch64-unknown-linux-musl; mise_arch=linux-arm64-musl; jj_sha="${JJ_SHA256_arm64}"; mise_sha="${MISE_SHA256_arm64}"; rg_arch=aarch64-unknown-linux-musl; rg_sha="${RIPGREP_SHA256_arm64}"; uv_arch=aarch64-unknown-linux-musl; uv_sha="${UV_SHA256_arm64}"; yq_sha="${YQ_SHA256_arm64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates curl file gh git jq \
      openssh-client patch pkg-config procps \
      python3 python3-venv python-is-python3 \
      rsync unzip xz-utils zip; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-buildx-plugin docker-ce-cli docker-compose-plugin; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL "https://github.com/jj-vcs/jj/releases/download/v${JJ_VERSION}/jj-v${JJ_VERSION}-${jj_arch}.tar.gz" -o /tmp/jj.tar.gz; \
    echo "${jj_sha}  /tmp/jj.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/jj.tar.gz -C /usr/local/bin ./jj; \
    curl -fsSL "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-${mise_arch}.tar.gz" -o /tmp/mise.tar.gz; \
    echo "${mise_sha}  /tmp/mise.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/mise.tar.gz -C /usr/local/bin --strip-components=2 mise/bin/mise; \
    MISE_DATA_DIR=/opt/mise MISE_CACHE_DIR=/tmp/mise-cache mise install "node@${NODE_VERSION}"; \
    ln -s "/opt/mise/installs/node/${NODE_VERSION}/bin/node" /usr/local/bin/node; \
    for command in corepack npm npx; do printf '#!/bin/sh\nexec /opt/mise/installs/node/%s/bin/%s "$@"\n' "${NODE_VERSION}" "${command}" > "/usr/local/bin/${command}"; chmod +x "/usr/local/bin/${command}"; done; \
    for command in pnpm yarn; do printf '#!/bin/sh\nexec /usr/local/bin/corepack %s "$@"\n' "${command}" > "/usr/local/bin/${command}"; chmod +x "/usr/local/bin/${command}"; done; \
    curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-${rg_arch}.tar.gz" -o /tmp/rg.tar.gz; \
    echo "${rg_sha}  /tmp/rg.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/rg.tar.gz -C /usr/local/bin --strip-components=1 "ripgrep-${RIPGREP_VERSION}-${rg_arch}/rg"; \
    curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv_arch}.tar.gz" -o /tmp/uv.tar.gz; \
    echo "${uv_sha}  /tmp/uv.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tar.gz -C /usr/local/bin --strip-components=1 "uv-${uv_arch}/uv" "uv-${uv_arch}/uvx"; \
    curl -fsSL "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_${TARGETARCH}" -o /usr/local/bin/yq; \
    echo "${yq_sha}  /usr/local/bin/yq" | sha256sum -c -; \
    chmod +x /usr/local/bin/yq; \
    npm install -g "agent-browser@${AGENT_BROWSER_VERSION}"; \
    useradd --create-home --uid 1000 --home-dir /workspace/home sandbox; \
    install -d -o sandbox -g sandbox "${CHROME_INSTALL_DIR}"; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 \
      libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 \
      libgtk-3-0t64 libpangocairo-1.0-0 libpango-1.0-0 \
      libatk1.0-0t64 libcairo-gobject2 libcairo2 \
      libgdk-pixbuf-2.0-0 libxrender1 libasound2t64 libfreetype6 \
      libfontconfig1 libdbus-1-3 libnss3 libnss3-tools libnspr4 \
      libatk-bridge2.0-0t64 libdrm2 libxkbcommon0 libatspi2.0-0t64 \
      libcups2t64 libxshmfence1 libgbm1 \
      fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf; \
    rm -rf /var/lib/apt/lists/*; \
    HOME="${CHROME_INSTALL_DIR}" "/opt/mise/installs/node/${NODE_VERSION}/bin/agent-browser" install; \
    chrome_bin="$(find "${CHROME_INSTALL_DIR}" -type f -name chrome -print -quit)"; \
    test -n "${chrome_bin}"; \
    ln -s "${chrome_bin}" /usr/local/bin/google-chrome; \
    ln -sf "/opt/mise/installs/node/${NODE_VERSION}/bin/agent-browser" /usr/local/bin/agent-browser; \
    chown -R sandbox:sandbox "${CHROME_INSTALL_DIR}"; \
    rm -rf /tmp/jj.tar.gz /tmp/mise.tar.gz /tmp/mise-cache /tmp/rg.tar.gz /tmp/uv.tar.gz; \
    mkdir -p /workspace /run/dsh; \
    chown -R sandbox:sandbox /workspace /run/dsh
COPY --from=build /dsh-runner /usr/local/bin/dsh-runner
# $HOME lives on the workspace volume so home files and caches survive a
# Kubernetes wake. A sandbox mounts its workspace volume over /workspace, which
# hides this image's copy, so the runner recreates the directory at startup.
# Chrome sits outside $HOME for the same reason: agent-browser searches $HOME
# for its own download, so a browser there would be invisible to every session.
# It is exposed as `google-chrome` on PATH instead, which is one of the names
# the CLI searches and the child-process PATH already includes.
ENV HOME=/workspace/home \
    MISE_DATA_DIR=/workspace/.dsh-state/mise \
    MISE_CACHE_DIR=/workspace/.dsh-state/mise-cache \
    PATH=/workspace/.dsh-state/mise/shims:/opt/mise/installs/node/${NODE_VERSION}/bin:$PATH
USER sandbox
WORKDIR /workspace
EXPOSE 8080
ENTRYPOINT ["dsh-runner"]
