FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /dsh-runner ./cmd/dsh-runner

FROM debian:trixie-slim
ARG JJ_VERSION=0.44.0
ARG JJ_SHA256=0a07bab4641a55fd2bc2fd1563ba3a3f9a577584086ad74086a1c5b69b3ffce9
ARG MISE_VERSION=2026.8.12
ARG MISE_SHA256=28027bc9b245b7c2e669cbfbc61cdfa1b8d4ecdd103d09070c75c8a85304d3be
RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://github.com/jj-vcs/jj/releases/download/v${JJ_VERSION}/jj-v${JJ_VERSION}-x86_64-unknown-linux-musl.tar.gz" -o /tmp/jj.tar.gz \
 && echo "${JJ_SHA256}  /tmp/jj.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/jj.tar.gz -C /usr/local/bin ./jj \
 && curl -fsSL "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64-musl.tar.gz" -o /tmp/mise.tar.gz \
 && echo "${MISE_SHA256}  /tmp/mise.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/mise.tar.gz -C /usr/local/bin --strip-components=2 mise/bin/mise \
 && rm /tmp/jj.tar.gz /tmp/mise.tar.gz \
 && useradd --create-home --uid 1000 sandbox \
 && mkdir -p /workspace /run/dsh \
 && chown sandbox:sandbox /workspace /run/dsh
COPY --from=build /dsh-runner /usr/local/bin/dsh-runner
ENV MISE_DATA_DIR=/workspace/.dsh-state/mise \
    MISE_CACHE_DIR=/workspace/.dsh-state/mise-cache \
    PATH=/workspace/.dsh-state/mise/shims:$PATH
USER sandbox
WORKDIR /workspace
EXPOSE 8080
ENTRYPOINT ["dsh-runner"]
