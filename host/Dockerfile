# The dsh-host image: dsh with the `web` profile assembled around the
# dsh-workbench provider. The build derives the dsh version from the
# provider's own dependency pins, so provider/package.json stays the single
# source of truth for which dsh this distribution ships.
#
# Layout rule: the image owns the software, the home volume owns the data.
# The runtime user's home is /data, so dsh sessions ($HOME/.dsh) and the
# provider's state ($HOME/.dsh-sandbox) land on one mount with no path
# configuration.

# Keep the Node version equal to mise.toml, which pins it for CI and local
# development.
FROM node:24.19.0-bookworm-slim AS build
ARG VERSION=0.0.0-dev
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY provider/ provider/
RUN pnpm install --frozen-lockfile --filter @zhming0/dsh-workbench

# Pack the provider as a real npm tarball (prepack builds it), so the runtime
# stage installs it exactly like a registry package, dependencies included.
# The provider derives its default runner image tag from its own version, so
# the release invariant "both images share one tag" is checked right here,
# where the version is stamped.
RUN mkdir -p /out/meta \
    && npm --prefix provider version "$VERSION" --no-git-tag-version --allow-same-version \
    && pnpm --dir provider pack --out /out/dsh-workbench.tgz \
    && node --input-type=module -e " \
        import { DEFAULT_RUNNER_IMAGE } from './provider/dist/runner-image.js'; \
        const expected = ':' + process.env.VERSION; \
        if (!DEFAULT_RUNNER_IMAGE.endsWith(expected)) { \
          throw new Error('default runner image ' + DEFAULT_RUNNER_IMAGE + ' does not end with ' + expected); \
        }" \
    && node -p "require('./provider/package.json').peerDependencies['@deepseek-ai/dsh-agent']" >/out/meta/dsh-version \
    && node -p "require('./package.json').packageManager" >/out/meta/package-manager \
    && printf '%s\n' "$VERSION" >/out/meta/version

FROM node:24.19.0-bookworm-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# git backs the provider's repository auto-detect fallback
# (`git remote get-url origin`) for sessions not created from a repository
# Workspace.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/meta /opt/dsh-host/meta
COPY --from=build /out/dsh-workbench.tgz /opt/dsh-host/dsh-workbench.tgz

# pnpm is what `dsh plugin` forwards to; dsh itself comes from npm at the
# version the provider pins.
RUN corepack install -g "$(cat /opt/dsh-host/meta/package-manager)" \
    && corepack enable pnpm \
    && npm install -g "@deepseek-ai/dsh@$(cat /opt/dsh-host/meta/dsh-version)" \
    && npm cache clean --force

# Assemble the web profile once, at build time, with the real installer, so
# the baked composition is exactly what `dsh plugin add` produces. The shipped
# template seeds a placeholder cordis.patch.yml (an empty patch list); drop it
# from the baked profile because that file is the user's, seeded separately by
# dsh-host-seed and never refreshed.
RUN DSH_HOME=/opt/dsh-host/seed dsh plugin --profile web add /opt/dsh-host/dsh-workbench.tgz \
    && rm /opt/dsh-host/seed/profiles/web/cordis.patch.yml \
    && mv /opt/dsh-host/seed/profiles/web /opt/dsh-host/profile \
    && rm -rf /opt/dsh-host/seed \
    && cp /opt/dsh-host/meta/version /opt/dsh-host/version

COPY host/cordis.patch.yml /opt/dsh-host/cordis.patch.yml
COPY host/dsh-host-seed host/dsh-host-entrypoint host/dsh-workbench /usr/local/bin/

# The node base image reserves uid 1000 for its unused `node` user; take it
# over so the volume-mounted /data has a predictable owner.
RUN userdel -r node \
    && useradd --uid 1000 --create-home --home-dir /data dsh \
    && chown -R dsh:dsh /opt/dsh-host

USER dsh
ENV HOME=/data
WORKDIR /data
EXPOSE 3000
ENTRYPOINT ["dsh-host-entrypoint"]
