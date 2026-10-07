#!/usr/bin/env bash
# Audited final switch only. No database or filesystem deletion is performed.
# Usage: cutover-v2.sh RELEASE_DIR BACKUP_DIR sha256:FULL_IMAGE_ID
# Read-only seal: cutover-v2.sh --seal-inputs RELEASE_DIR sha256:FULL_IMAGE_ID
set -Eeuo pipefail
umask 077

if [[ ${1:-} == --seal-inputs ]]; then
  [[ $# == 3 ]]
  release=$(realpath -- "$2")
  exec python3 "$release/source/deployment/cutover-inputs.py" seal "$release" "$3"
fi
[[ $# == 3 ]] || { printf '%s\n' '{"status":"argument-guard-rejected"}'; exit 2; }
release=$(realpath -- "$1")
backup=$(realpath -- "$2")
image=$3
base=$(realpath -- "${SHUSHA_BASE_DIR:-${release%%/releases/*}}")
old=${SHUSHA_OLD_CONTAINER:-evershop}
pg=${SHUSHA_POSTGRES_CONTAINER:-pg}
network=${SHUSHA_DOCKER_NETWORK:-MyEverShop}
database=${SHUSHA_PRODUCTION_DB:-shusha_v2_production}
rollback=${SHUSHA_ROLLBACK_CONTAINER:-evershop-v1-rollback}
maintenance=${SHUSHA_MAINTENANCE_CONTAINER:-evershop-v2-maintenance}
port=${SHUSHA_PUBLIC_PORT:-5433}
home=${SHUSHA_HOME_URL:-https://shop.this-time.com}
acceptance=${SHUSHA_ACCEPTANCE_FILE:-$release/private-candidate/acceptance.json}
shared=${SHUSHA_V2_SHARED_DIR:-$base/shared-v2}
shared=$(realpath -m -- "$shared")
[[ "$release" == "$base/"* && "$backup" == "$base/"* ]]
source=$(realpath -- "$release/source")
[[ "$source" == "$base/"* ]]
[[ "$shared" == "$base/"* && "$shared" != *'/../'* && "$shared" != *'/./'* ]]
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ && "$database" =~ ^[a-z][a-z0-9_]*_production$ ]]
[[ "$port" =~ ^[0-9]+$ && "$port" -ge 1024 && "$port" -le 65535 ]]
for name in "$old" "$pg" "$network" "$rollback" "$maintenance"; do
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]
done
[[ "$old" != "$rollback" && "$old" != "$maintenance" && "$pg" != "$old" ]]
[[ ! -e "$shared" && ! -L "$shared" ]]
run=$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import uuid; print(uuid.uuid4().hex[:12])')
final="$backup/final-$run"
mkdir -m 700 -- "$final"
exec 2>>"$final/cutover.private.log"
stage=preflight
old_stopped=0
old_renamed=0
public_started=0
maintenance_created=0

present() { [[ -n $(docker ps -aq --filter "name=^/$1$") ]]; }
assert_absent() {
  local ids
  ids=$(docker ps -aq --filter "name=^/$1$")
  [[ -z "$ids" ]]
}
quiet() { "$@" >>"$final/cutover.private.log" 2>&1; }
check_jobs() {
  local locks
  [[ ! -e "$library/.adapter.lock" ]]
  locks=$(find "$library/jobs" -maxdepth 1 -name '*.lock' -print)
  [[ -z "$locks" ]]
}
restore_old() {
  if present "$old" && [[ "$old_renamed" == 1 ]]; then
    quiet docker rename "$old" "evershop-v2-failed-$run" || return 1
  fi
  if [[ "$old_renamed" == 1 ]]; then
    quiet docker rename "$rollback" "$old" || return 1
    old_renamed=0
  fi
  quiet docker start "$old" || return 1
  [[ $(docker inspect "$old" --format '{{.State.Running}}') == true ]]
}
failed() {
  local code=$?
  trap - ERR INT TERM
  set +e
  local result=preflight-rejected resumed=false rollback_guard=false
  if [[ "$public_started" == 1 ]]; then
    result=failed-new-business-data-protected
    # Stop both the web writer and its native job child before the recovery
    # snapshot. No rollback is allowed if the snapshot or strict guard fails.
    if quiet docker stop -t 60 "$old"; then
      mkdir -m 700 -- "$final/v2-failure"
      docker inspect "$old" >"$final/v2-failure/container.private.json"
      if docker exec "$pg" pg_dump -U postgres -Fc -d "$database" >"$final/v2-failure/database.dump" &&
         quiet cp -a -- "$shared/data" "$shared/media" "$shared/private" "$shared/config-runtime" "$final/v2-failure/" &&
         quiet docker start "$maintenance" &&
         docker exec "$maintenance" node deployment/verify-baseline.mjs --baseline /private/pre-public-v2.private.json >"$final/v2-failure/rollback-guard.private.json" 2>>"$final/cutover.private.log"; then
        rollback_guard=true
        quiet docker stop -t 30 "$maintenance"
        if restore_old; then result=failed-old-resumed; resumed=true; fi
      fi
    fi
  elif [[ "$old_stopped" == 1 ]]; then
    if [[ "$maintenance_created" == 1 ]]; then quiet docker stop -t 30 "$maintenance"; fi
    if restore_old; then result=failed-old-resumed; resumed=true; else result=failed-old-resume-required; fi
  fi
  printf '{"status":"%s","stage":"%s","oldResumed":%s,"rollbackGuardPassed":%s,"detailsWithheld":true}\n' \
    "$result" "$stage" "$resumed" "$rollback_guard" >"$final/failure.private.json"
  cat "$final/failure.private.json"
  if [[ "$public_started" == 1 && "$resumed" != true ]]; then exit 3; fi
  [[ "$code" != 0 ]] || code=2
  exit "$code"
}
trap failed ERR
trap 'false' INT TERM

python3 "$source/deployment/cutover-inputs.py" verify "$release" "$image" "$acceptance"
[[ $(docker inspect "$image" --format '{{.Id}}') == "$image" ]]
[[ $(docker inspect "$old" --format '{{.State.Running}}') == true ]]
[[ $(docker inspect "$pg" --format '{{.State.Running}}') == true ]]
assert_absent "$rollback"
assert_absent "$maintenance"
docker inspect "$old" >"$final/old-container.private.json"
docker image inspect "$image" >"$final/new-image.private.json"
mapfile -t facts < <(python3 - "$final/old-container.private.json" "$base" "$network" "$port" <<'PY'
import json, re, sys
from pathlib import Path
old = json.loads(Path(sys.argv[1]).read_text())[0]
base = Path(sys.argv[2]).resolve(strict=True)
assert sys.argv[3] in old['NetworkSettings']['Networks']
env = dict(value.split('=', 1) for value in old['Config']['Env'])
assert re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', env['DB_NAME'])
assert re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', env['DB_USER'])
mounts = {value['Destination']: value for value in old['Mounts']}
def mounted(destination, suffix=''):
    item = mounts[destination]
    assert item['Type'] == 'bind'
    filename = Path(item['Source'], suffix).resolve(strict=True)
    assert base in filename.parents and filename.is_dir()
    assert '\n' not in str(filename)
    return str(filename)
library = mounted('/app/data/material-library') if '/app/data/material-library' in mounts else mounted('/app/data', 'material-library')
wise = mounted('/wise-private') if '/wise-private' in mounts else mounted('/private')
bindings = old['HostConfig']['PortBindings']['3000/tcp']
assert len(bindings) == 1 and bindings[0]['HostPort'] == sys.argv[4]
host = bindings[0].get('HostIp', '')
assert host in ('', '0.0.0.0', '127.0.0.1') or re.fullmatch(r'(?:\d{1,3}\.){3}\d{1,3}', host)
for value in (library, mounted('/app/media'), wise, mounted('/app/config'), env['DB_NAME'], env['DB_USER'], host or '-'):
    print(value)
PY
)
[[ ${#facts[@]} == 7 ]]
library=${facts[0]}; media=${facts[1]}; wise=${facts[2]}; oldconfig=${facts[3]}
old_database=${facts[4]}; app_user=${facts[5]}; host=${facts[6]}
[[ "$old_database" != "$database" ]]
[[ -d "$library/jobs" && -s "$wise/receiving.json" ]]
check_jobs
existing_database=$(docker exec "$pg" psql -U postgres -d postgres -Atc "SELECT datname FROM pg_database WHERE datname='$database'")
[[ -z "$existing_database" ]]
old_version=$(docker exec "$old" node -e 'const f=require("node:fs");const p=["/app/node_modules/@evershop/evershop/package.json","/app/packages/evershop/package.json"].find(x=>f.existsSync(x));if(!p)process.exit(1);process.stdout.write(JSON.parse(f.readFileSync(p)).version)')
[[ "$old_version" == 1.2.2 ]]
# Avoid beginning the final pause if input derivation already fails. The
# authoritative copies below are made again after all old writers stop.
quiet cp -a -- "$oldconfig" "$final/config"
mkdir -m 700 -- "$shared"
[[ $(realpath -- "$shared") == "$shared" ]]
mkdir -m 700 -- "$shared/data" "$shared/media" "$shared/private" "$shared/config-maintenance" "$shared/config-runtime"
python3 "$source/deployment/cutover-inputs.py" prepare "$release" "$final" "$shared" "$database" "$home"

stage=stop-old-writers
[[ $(docker inspect "$old" --format '{{.Id}}') == $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[0]["Id"])' "$final/old-container.private.json") ]]
old_stopped=1
quiet docker stop -t 60 "$old"
[[ $(docker inspect "$old" --format '{{.State.Running}}') == false ]]
[[ $(docker inspect "$old" --format '{{.Id}}') == $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[0]["Id"])' "$final/old-container.private.json") ]]
check_jobs
# The observer also connects to postgres, which may itself be the old store.
# Exclude only this backend; all other clients, including idle ones, still block.
[[ $(docker exec "$pg" psql -U postgres -d postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname='$old_database' AND backend_type='client backend' AND pid <> pg_backend_pid()") == 0 ]]
stage=final-backup
docker exec "$pg" pg_dump -U postgres -Fc -d "$old_database" >"$final/database.dump"
[[ -s "$final/database.dump" ]]
docker inspect "$old" >"$final/stopped-container.private.json"
quiet cp -a -- "$media" "$final/media"
quiet cp -a -- "$library" "$final/material-library"
quiet cp -a -- "$wise" "$final/wise-private"
# The original config/session copy is kept; also save its final frozen state.
quiet cp -a -- "$oldconfig" "$final/frozen-config"
quiet diff -qr -- "$final/config" "$final/frozen-config"
quiet cp -a -- "$final/media/." "$shared/media/"
quiet cp -a -- "$final/material-library" "$shared/data/material-library"
quiet cp -a -- "$final/wise-private" "$shared/private/wise-private"
quiet cp -a -- "$final/wise-private/receiving.json" "$shared/private/receiving.json"
cmp -s -- "$shared/private/receiving.json" "$release/private-candidate/receiving.json"
find "$final" "$shared/private" "$shared/data" "$shared/config-maintenance" "$shared/config-runtime" -type f -exec chmod 600 -- {} +

stage=restore-final-copy
quiet docker exec "$pg" createdb -U postgres -O "$app_user" "$database"
docker exec -i "$pg" pg_restore -U postgres --exit-on-error -d "$database" <"$final/database.dump" >>"$final/cutover.private.log" 2>&1
quiet docker create --name "$maintenance" --network "$network" --env-file "$shared/private/maintenance.env" --workdir /app --restart no \
  -v "$shared/config-maintenance:/app/config:ro" -v "$shared/private:/private" \
  -v "$shared/data:/app/data" -v "$shared/media:/app/media" "$image" sleep infinity
maintenance_created=1
quiet docker start "$maintenance"
stage=capture-original-invariants
docker exec "$maintenance" node deployment/capture-baseline.mjs --output /private/final-before.private.json --source-version 1.2.2 >"$final/before-counts.private.json"
stage=native-migration
docker exec "$maintenance" node deployment/migrate-v2.mjs --allow-production >"$final/migration.private.json"
stage=content-adaptation
docker exec "$maintenance" node deployment/adapt-store-content.mjs --apply --expected-database "$database" >"$final/adaptation.private.json"
package=$(python3 - "$final/adaptation.private.json" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
assert result['status'] == 'applied' and isinstance(result['packageId'], int) and result['packageId'] > 0
print(result['packageId'])
PY
)
printf 'MATERIAL_PUBLICATION_PACKAGE_ID=%s\n' "$package" >>"$shared/private/productionruntime.env"
stage=verify-final-invariants
docker exec "$maintenance" node deployment/verify-baseline.mjs --baseline /private/final-before.private.json >"$final/baseline-verification.private.json"
docker exec "$maintenance" node deployment/adapt-store-content.mjs --verify --expected-database "$database" >"$final/content-verification.private.json"
docker exec "$maintenance" node deployment/capture-baseline.mjs --output /private/pre-public-v2.private.json --source-version 2.2.1 >"$final/pre-public-counts.private.json"
quiet cp -a -- "$shared/private/final-before.private.json" "$shared/private/pre-public-v2.private.json" "$shared/private/productionruntime.env" "$final/"
python3 "$source/deployment/cutover-inputs.py" verify "$release" "$image" "$acceptance" >>"$final/cutover.private.log"
check_jobs
quiet docker stop -t 30 "$maintenance"

stage=start-public-v2
quiet docker rename "$old" "$rollback"
old_renamed=1
binding="$port:3000"
[[ "$host" == - ]] || binding="$host:$binding"
quiet docker create --name "$old" --network "$network" --env-file "$shared/private/productionruntime.env" --workdir /app --restart unless-stopped \
  -p "$binding" -v "$shared/config-runtime:/app/config:ro" -v "$shared/private:/private" \
  -v "$shared/data:/app/data" -v "$shared/media:/app/media" "$image"
# Set the boundary before start; a partially failed start may have accepted writes.
public_started=1
quiet docker start "$old"
stage=public-health
healthy=false
for attempt in $(seq 1 30); do
  if [[ $(docker inspect "$old" --format '{{.State.Running}}') != true ]]; then break; fi
  if quiet docker exec "$old" node -e 'fetch("http://127.0.0.1:3000/",{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then
    healthy=true
    break
  fi
  sleep 3
done
[[ "$healthy" == true ]]
stage=runtime-child-processes
docker exec "$old" node deployment/runtime-processes.mjs >"$final/runtime-processes-1.private.json"
sleep 3
docker exec "$old" node deployment/runtime-processes.mjs >"$final/runtime-processes-2.private.json"
[[ $(docker inspect "$rollback" --format '{{.State.Running}}') == false ]]
[[ $(docker inspect "$old" --format '{{.Image}}') == "$image" ]]
docker inspect "$old" >"$final/public-container.private.json"
printf '%s\n' '{"status":"cutover-complete","finalBaselinePassed":true,"publicHealthPassed":true,"oldDatabasePreserved":true,"oldContainerStopped":true,"configuredJobs":2,"cronProcesses":1,"eventManagerProcesses":1,"timezone":"Asia/Shanghai"}' >"$final/success.private.json"
cat "$final/success.private.json"
trap - ERR INT TERM
