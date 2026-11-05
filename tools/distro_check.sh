#!/usr/bin/env bash
# Runs the current commit from source on other Linux distributions, the way the README tells a person
# to, in one rootless Podman container per image, all at the same time. It needs the network and takes
# several minutes. Only committed work is tested: each container clones this checkout.
#
#   tools/distro_check.sh [--gitleaks-release 8.21.0] [image ...]
#
# Each container prints one "== STEP <name>: ok|FAIL" line per step. The app steps run as a normal user
# before Node.js is installed. --gitleaks-release installs that official gitleaks release, checked
# against its checksums file, instead of the distribution's package. The exit status is 1 when an app
# step failed on any image.
set -euo pipefail

REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
GITLEAKS_RELEASE=
IMAGES=()
while (($#)); do
  case $1 in
    --gitleaks-release) GITLEAKS_RELEASE=$2; shift 2 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) IMAGES+=("$1"); shift ;;
  esac
done
if ((${#IMAGES[@]} == 0)); then
  IMAGES=(docker.io/library/ubuntu:24.04 docker.io/library/debian:stable registry.fedoraproject.org/fedora:latest)
fi
command -v podman >/dev/null || { echo "distro_check: podman is not installed" >&2; exit 2; }

LOGS=$(mktemp -d -t pcbv-distro-check.XXXXXX)

# Runs inside the container as root. App steps are marked "app"; only those decide the exit status.
read -r -d '' INSIDE <<'EOF' || true
set -u
APP_FAILED=0
step() {  # step <app|dev> <name> <command...>
  local kind=$1 name=$2; shift 2
  if "$@" > "/tmp/step-$name.log" 2>&1; then
    echo "== STEP $name: ok"
  else
    echo "== STEP $name: FAIL"
    tail -n 30 "/tmp/step-$name.log" | sed 's/^/   | /'
    [ "$kind" = app ] && APP_FAILED=1
  fi
}
as_user() { runuser -u tester -- env HOME=/home/tester PATH=/usr/local/bin:/usr/bin:/bin bash -c "$1"; }

packages() {
  local gitleaks=gitleaks
  [ -n "$GITLEAKS_RELEASE" ] && gitleaks=
  if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq && apt-get install -y -qq git curl ca-certificates python3 python3-venv xz-utils $gitleaks
  else
    dnf install -y -q git curl python3 util-linux shadow-utils tar xz $gitleaks
  fi
}

gitleaks_release() {
  local arch archive
  case $(uname -m) in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) return 1 ;; esac
  archive="gitleaks_${GITLEAKS_RELEASE}_linux_${arch}.tar.gz"
  cd /tmp || return 1
  curl -fsSLO "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_RELEASE}/${archive}" &&
    curl -fsSLO "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_RELEASE}/gitleaks_${GITLEAKS_RELEASE}_checksums.txt" &&
    grep " ${archive}\$" "gitleaks_${GITLEAKS_RELEASE}_checksums.txt" | sha256sum -c - &&
    tar -xzf "$archive" -C /usr/local/bin gitleaks
}

uv_tool() { python3 -m venv /opt/uv && /opt/uv/bin/pip install -q uv && ln -sf /opt/uv/bin/uv /usr/local/bin/uv; }

checkout() {
  useradd -m tester &&
    git clone -q /src /home/tester/pcb-visualizer &&
    chown -R tester: /home/tester/pcb-visualizer
}

serve() {
  as_user 'cd ~/pcb-visualizer/service && (setsid uv run pcbv serve > /tmp/serve.log 2>&1 &)' &&
    for _ in $(seq 120); do
      curl -fsS http://127.0.0.1:8765/api/health > /dev/null 2>&1 && return 0
      sleep 1
    done
  cat /tmp/serve.log
  return 1
}

bench_check() {
  local token
  token=$(python3 -c 'import json; print(json.load(open("/home/tester/.cache/pcbv/service.json"))["token"])') &&
    curl -fsS -H "Authorization: Bearer $token" -H "X-PCBV-Protocol: 2" http://127.0.0.1:8765/api/bench-check |
    python3 -c 'import json, sys
for c in json.load(sys.stdin)["checks"]:
    print("   %s: %s. %s Fix: %s" % (c["id"], "ok" if c["ok"] else "missing", c["label"], c["fix"]))'
}

node22() {
  local major=0 arch file
  if command -v apt-get >/dev/null; then
    major=$(apt-cache policy nodejs | awk '/Candidate:/ {print $2}' | sed 's/^[0-9]*://; s/[^0-9].*//')
    [ "${major:-0}" -ge 22 ] 2>/dev/null && { apt-get install -y -qq nodejs npm; return; }
  else
    dnf install -y -q nodejs npm && major=$(node -p 'process.versions.node.split(".")[0]')
    [ "$major" -ge 22 ] && return 0
  fi
  case $(uname -m) in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) return 1 ;; esac
  cd /tmp || return 1
  curl -fsSLO https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt || return 1
  file=$(awk -v a="linux-$arch.tar.xz" '$2 ~ a"$" {print $2}' SHASUMS256.txt)
  curl -fsSLO "https://nodejs.org/dist/latest-v22.x/$file" &&
    grep " $file\$" SHASUMS256.txt | sha256sum -c - &&
    mkdir -p /opt/node && tar -xJf "$file" -C /opt/node --strip-components=1 &&
    ln -sf /opt/node/bin/node /opt/node/bin/npm /opt/node/bin/npx /usr/local/bin/
}

tests() {
  as_user 'cd ~/pcb-visualizer && PYTEST_ADDOPTS=-rfEs npm run test:all > /tmp/tests.log 2>&1'
  local status=$?
  grep -E '^# (pass|fail) ' /tmp/tests.log | sed 's/^/   front end /'
  grep -E '^FAILED|^ERROR' /tmp/tests.log | sed 's/^/   service /'
  grep -E '^SKIPPED' /tmp/tests.log | sed 's/^SKIPPED \[\([0-9]*\)\] [^:]*:[0-9]*: /SKIPPED x\1: /' |
    sort | uniq -c | sed 's/^/   service /'
  grep -E '[0-9]+ (passed|failed)' /tmp/tests.log | tail -n 1 | sed 's/^/   service /'
  return $status
}

step app packages packages
if [ -n "$GITLEAKS_RELEASE" ]; then step app gitleaks-release gitleaks_release; fi
echo "   gitleaks: $(command -v gitleaks || echo none) ($(gitleaks version 2>/dev/null || echo no version))"
step app uv uv_tool
step app checkout checkout
step app demo as_user 'cd ~/pcb-visualizer/service && uv run pcbv demo'
step app serve serve
step app health curl -fsS http://127.0.0.1:8765/api/health
step app app-page sh -c 'curl -fsS http://127.0.0.1:8765/ | grep -q "<title>PCB Visualizer</title>"'
step app bench-check bench_check
cat /tmp/step-bench-check.log
step dev node node22
echo "   node: $(node --version 2>/dev/null || echo none)"
step dev npm-install as_user 'cd ~/pcb-visualizer && npm install --no-audit --no-fund'
step dev uv-sync as_user 'cd ~/pcb-visualizer/service && uv sync'
step dev tests tests
grep '^   ' /tmp/step-tests.log
exit $APP_FAILED
EOF

pids=()
for image in "${IMAGES[@]}"; do
  name=$(printf '%s' "$image" | tr -c 'A-Za-z0-9.-' '_')
  echo "distro_check: starting $image (log: $LOGS/$name.log)"
  podman run --rm --security-opt label=disable -v "$REPO:/src:ro" -e GITLEAKS_RELEASE="$GITLEAKS_RELEASE" \
    "$image" bash -c "$INSIDE" > "$LOGS/$name.log" 2>&1 &
  pids+=($!)
done

failed=0
for i in "${!IMAGES[@]}"; do
  status=0
  wait "${pids[$i]}" || status=$?
  name=$(printf '%s' "${IMAGES[$i]}" | tr -c 'A-Za-z0-9.-' '_')
  echo
  echo "== ${IMAGES[$i]}: $([ "$status" -eq 0 ] && echo "app steps ok" || echo "app step FAILED")"
  cat "$LOGS/$name.log"
  [ "$status" -eq 0 ] || failed=1
done
echo
echo "distro_check: logs in $LOGS"
exit $failed
