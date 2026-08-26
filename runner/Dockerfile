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
ARG MISE_VERSION=2026.8.12
ARG MISE_SHA256_amd64=28027bc9b245b7c2e669cbfbc61cdfa1b8d4ecdd103d09070c75c8a85304d3be
ARG MISE_SHA256_arm64=ca536cb34d746a1caa1ad43d37c548e0f45c1d4192b2eaac38dc400d23940c7d
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) jj_arch=x86_64-unknown-linux-musl;  mise_arch=linux-x64-musl;   jj_sha="${JJ_SHA256_amd64}"; mise_sha="${MISE_SHA256_amd64}" ;; \
      arm64) jj_arch=aarch64-unknown-linux-musl; mise_arch=linux-arm64-musl; jj_sha="${JJ_SHA256_arm64}"; mise_sha="${MISE_SHA256_arm64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends git bash ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL "https://github.com/jj-vcs/jj/releases/download/v${JJ_VERSION}/jj-v${JJ_VERSION}-${jj_arch}.tar.gz" -o /tmp/jj.tar.gz; \
    echo "${jj_sha}  /tmp/jj.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/jj.tar.gz -C /usr/local/bin ./jj; \
    curl -fsSL "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-${mise_arch}.tar.gz" -o /tmp/mise.tar.gz; \
    echo "${mise_sha}  /tmp/mise.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/mise.tar.gz -C /usr/local/bin --strip-components=2 mise/bin/mise; \
    rm /tmp/jj.tar.gz /tmp/mise.tar.gz; \
    useradd --create-home --uid 1000 sandbox; \
    mkdir -p /workspace /run/dsh; \
    chown sandbox:sandbox /workspace /run/dsh
COPY --from=build /dsh-runner /usr/local/bin/dsh-runner
ENV MISE_DATA_DIR=/workspace/.dsh-state/mise \
    MISE_CACHE_DIR=/workspace/.dsh-state/mise-cache \
    PATH=/workspace/.dsh-state/mise/shims:$PATH
USER sandbox
WORKDIR /workspace
EXPOSE 8080
ENTRYPOINT ["dsh-runner"]
