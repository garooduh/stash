#!/usr/bin/env bash
# Deploy only the Stash frontend and its package-data declaration over the stash SSH alias.
set -Eeuo pipefail

project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
stage_dir=$(mktemp -d /tmp/stash-frontend-stage.XXXXXX)
bundle=$(mktemp /tmp/stash-frontend.XXXXXX.tar.gz)
remote_script=$(mktemp /tmp/stash-frontend.XXXXXX.sh)
remote_bundle="/tmp/stash-frontend-${stamp}.tar.gz"
remote_script_path="/tmp/stash-frontend-${stamp}.sh"
files=(
  pyproject.toml
  stash/templates/index.html
  stash/static/style.css
  stash/static/app.js
  stash/static/favicon.png
  stash/static/logo.png
)
cleanup() { rm -rf -- "$stage_dir" "$bundle" "$remote_script"; }
trap cleanup EXIT

for file in "${files[@]}"; do
  mkdir -p -- "$stage_dir/$(dirname "$file")"
  cp -- "$project_dir/$file" "$stage_dir/$file"
done
(
  cd "$stage_dir"
  sha256sum "${files[@]}" > SHA256SUMS
  tar -czf "$bundle" SHA256SUMS "${files[@]}"
)

cat > "$remote_script" <<'REMOTE'
set -Eeuo pipefail
stamp=$1
mode=${2:-deploy}
bundle="/tmp/stash-frontend-${stamp}.tar.gz"
stage="/tmp/stash-frontend-${stamp}"
backup="/opt/stash/.deploy-backups/frontend-${stamp}"
files=(
  pyproject.toml
  stash/templates/index.html
  stash/static/style.css
  stash/static/app.js
  stash/static/favicon.png
  stash/static/logo.png
)
restore() {
  test -d "$backup"
  cd /opt/stash
  for file in "${files[@]}"; do
    if [[ -f "$backup/$file.missing" ]]; then
      rm -f -- "$file"
    else
      cp -p -- "$backup/$file" "$file"
    fi
  done
  systemctl restart stash.service
}
if [[ "$mode" == rollback ]]; then
  restore
  systemctl is-active --quiet stash.service
  exit 0
fi
mkdir -p -- "$stage" "$backup"
tar -xzf "$bundle" -C "$stage"
(cd "$stage" && sha256sum -c SHA256SUMS)
cd /opt/stash
for file in "${files[@]}"; do
  mkdir -p -- "$backup/$(dirname "$file")"
  if [[ -f "$file" ]]; then
    cp -p -- "$file" "$backup/$file"
  else
    touch -- "$backup/$file.missing"
  fi
done
deployment_started=false
on_exit() {
  status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$deployment_started" == true ]]; then
    restore || true
  fi
  exit "$status"
}
trap on_exit EXIT
deployment_started=true
for file in "${files[@]}"; do
  cp -- "$stage/$file" "$file"
  chmod 0644 -- "$file"
done
sha256sum -c "$stage/SHA256SUMS"
systemctl restart stash.service
systemctl is-active --quiet stash.service
health_ok=false
for _ in 1 2 3 4 5; do
  if /opt/stash/.venv/bin/python -c 'import urllib.request; assert urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=3).status == 200'; then
    health_ok=true
    break
  fi
  sleep 1
done
if [[ "$health_ok" != true ]]; then
  exit 1
fi
if ! /opt/stash/.venv/bin/python - <<'PY'
import urllib.request
for path, content_type in (
    ('/', 'text/html'),
    ('/static/style.css', 'text/css'),
    ('/static/app.js', 'javascript'),
    ('/static/favicon.png', 'image/png'),
    ('/static/logo.png', 'image/png'),
):
    with urllib.request.urlopen('http://127.0.0.1:8080' + path, timeout=5) as response:
        assert response.status == 200, path
        assert content_type in response.headers['Content-Type'], path
print('Stash frontend HTTP checks passed')
PY
then
  exit 1
fi
systemctl is-active stash.service
journalctl -u stash.service -n 15 --no-pager || true
printf 'Backup: %s\n' "$backup"
deployment_started=false
REMOTE

ssh_options=(-F "$HOME/.ssh/config" -o BatchMode=yes -o ConnectTimeout=8)
ssh "${ssh_options[@]}" stash \
  'systemctl is-active --quiet stash.service && test -f /opt/stash/stash/main.py'
ssh "${ssh_options[@]}" nginx 'nginx -t && systemctl is-active --quiet nginx'
scp "${ssh_options[@]}" "$bundle" "stash:$remote_bundle"
scp "${ssh_options[@]}" "$remote_script" "stash:$remote_script_path"
ssh "${ssh_options[@]}" stash "/bin/bash '$remote_script_path' '$stamp'"

if ! ssh "${ssh_options[@]}" nginx 'nginx -t && systemctl is-active --quiet nginx' || \
   ! curl --connect-timeout 5 --max-time 10 -fsS \
     --resolve stash.qbob.ru:443:192.168.1.11 https://stash.qbob.ru/health; then
  ssh "${ssh_options[@]}" stash "/bin/bash '$remote_script_path' '$stamp' rollback" || true
  echo 'Post-deploy proxy check failed; rollback attempted.' >&2
  exit 1
fi
printf '\nFrontend deployed. Backup in LXC 208: /opt/stash/.deploy-backups/frontend-%s\n' "$stamp"
