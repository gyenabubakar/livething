#!/bin/sh
# Gets a fresh Linux machine (x64 or arm64, Ubuntu or Amazon Linux) ready to run the load
# benchmark: installs build tools, Node.js and the repo's pnpm, then installs and builds the
# packages. It needs sudo. Run it from anywhere in the repo:
#
#   sh server-adapters/node/bench/setup-machine.sh
#
# NODE_VERSION picks the Node.js version (default 24.12.0, the one the docs' numbers use).
set -eu

node_version="${NODE_VERSION:-24.12.0}"
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "No Node.js build for $(uname -m)." >&2; exit 1 ;;
esac

cd "$(git rev-parse --show-toplevel)"

# better-sqlite3 builds from source when it cannot download a prebuilt binary.
if command -v apt-get >/dev/null; then
  sudo apt-get update -q
  sudo apt-get install -y -q build-essential python3 xz-utils curl
elif command -v dnf >/dev/null; then
  sudo dnf install -y -q gcc-c++ make python3 xz tar curl
fi

if [ "$(node --version 2>/dev/null)" != "v$node_version" ]; then
  curl -fsSL "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-$arch.tar.xz" |
    sudo tar -xJ -C /usr/local --strip-components=1
fi

pnpm_version="$(node -p "require('./package.json').packageManager.split('@')[1]")"
if [ "$(pnpm --version 2>/dev/null)" != "$pnpm_version" ]; then
  sudo npm install --global "pnpm@$pnpm_version"
fi

# The install also builds the packages.
pnpm install --frozen-lockfile

echo "Ready. Node.js $(node --version), pnpm $(pnpm --version)."
