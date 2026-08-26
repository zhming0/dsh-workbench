# Shared Node bootstrap for steps that do not run on the Node image.
# Source this, then call ensure_node before using node, npm, or pnpm.

NODE_VERSION="24.19.0"
NODE_SHA256_x64="14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647"
NODE_SHA256_arm64="01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc"

ensure_node() {
  if command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ]]; then
    echo "Using preinstalled Node $(node -v)"
    return
  fi

  local arch sha
  case "$(uname -m)" in
    x86_64)        arch="x64";   sha="$NODE_SHA256_x64" ;;
    aarch64|arm64) arch="arm64"; sha="$NODE_SHA256_arm64" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; return 1 ;;
  esac

  echo "--- :nodejs: Installing Node ${NODE_VERSION}"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" -o /tmp/node.tar.xz
  echo "${sha}  /tmp/node.tar.xz" | sha256sum -c -
  tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local
  rm /tmp/node.tar.xz
}

# Run pnpm at the version this repository pins, without a global install.
pnpm() {
  local version
  version="$(node -p "require('$(git rev-parse --show-toplevel)/package.json').packageManager.split('@')[1]")"
  npm exec --yes --package="pnpm@${version}" -- pnpm "$@"
}
