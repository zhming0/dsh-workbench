# Shared toolchain bootstrap. Source this, then call ensure_tools before using
# any tool that mise.toml pins.
#
# mise.toml holds every tool version. Only mise itself is pinned here, because
# something has to exist before mise can read its own config. The version and
# checksums match runner/Dockerfile so CI and the sandbox image install the same
# mise release.
MISE_VERSION="2026.8.12"
MISE_SHA256_x64="28027bc9b245b7c2e669cbfbc61cdfa1b8d4ecdd103d09070c75c8a85304d3be"
MISE_SHA256_arm64="ca536cb34d746a1caa1ad43d37c548e0f45c1d4192b2eaac38dc400d23940c7d"

# corepack asks before downloading a package manager, which would hang a step.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

install_mise() {
  local arch sha
  case "$(uname -m)" in
    x86_64)        arch="linux-x64-musl";   sha="$MISE_SHA256_x64" ;;
    aarch64|arm64) arch="linux-arm64-musl"; sha="$MISE_SHA256_arm64" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; return 1 ;;
  esac

  echo "--- :toolbox: Installing mise ${MISE_VERSION}"
  mkdir -p "$HOME/.local/bin"
  curl -fsSL "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-${arch}.tar.gz" -o /tmp/mise.tar.gz
  echo "${sha}  /tmp/mise.tar.gz" | sha256sum -c -
  tar -xzf /tmp/mise.tar.gz -C "$HOME/.local/bin" --strip-components=2 mise/bin/mise
  rm /tmp/mise.tar.gz
  PATH="$HOME/.local/bin:$PATH"
}

# Put every tool that mise.toml pins on PATH, plus pnpm.
ensure_tools() {
  command -v mise >/dev/null 2>&1 || install_mise

  echo "--- :toolbox: Installing tools from mise.toml"
  local root
  root="$(git rev-parse --show-toplevel)"
  mise trust "${root}/mise.toml"
  mise install --cd "$root"
  eval "$(mise activate bash --shims)"

  # The `packageManager` field in package.json pins pnpm and corepack reads it,
  # so no version belongs here. This has to be a real binary rather than a shell
  # function, because pnpm scripts call pnpm again in a child process.
  mkdir -p "$HOME/.local/bin"
  PATH="$HOME/.local/bin:$PATH"
  corepack enable pnpm --install-directory "$HOME/.local/bin"
}
