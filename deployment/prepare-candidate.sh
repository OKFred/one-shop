#!/bin/bash
set -Eeuo pipefail
umask 077
# Usage: prepare-candidate.sh RELEASE_DIR BACKUP_DIR IMAGE
release=$(realpath "$1")
backup=$(realpath "$2")
image=$3
old=${SHUSHA_OLD_CONTAINER:-evershop}
pg=${SHUSHA_POSTGRES_CONTAINER:-pg}
db=${SHUSHA_CANDIDATE_DB:-shusha_v2_candidate}
network=${SHUSHA_DOCKER_NETWORK:-MyEverShop}
preview_host=${SHUSHA_PREVIEW_BIND_HOST:-127.0.0.1}
[[ "$preview_host" == 127.0.0.1 || "$preview_host" =~ ^192\.168\.[0-9]+\.[0-9]+$ || "$preview_host" =~ ^10\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$db" =~ ^[a-z][a-z0-9_]*_candidate$ ]]
test -s "$backup/database.dump"
test -f "$release/source/deployment/config.shusha.json"
test ! -e "$release/candidate.env"
test -z "$(docker ps -aq --filter 'name=^/evershop-v2-candidate$')"
test -z "$(docker exec "$pg" psql -U postgres -d postgres -Atc "SELECT datname FROM pg_database WHERE datname='$db'")"
test "$(docker inspect "$old" --format '{{.State.Running}}')" = true
shared=$(docker inspect "$old" --format '{{range .Mounts}}{{if eq .Destination "/app/data/material-library"}}{{.Source}}{{end}}{{end}}')
media=$(docker inspect "$old" --format '{{range .Mounts}}{{if eq .Destination "/app/media"}}{{.Source}}{{end}}{{end}}')
wise=$(docker inspect "$old" --format '{{range .Mounts}}{{if eq .Destination "/wise-private"}}{{.Source}}{{end}}{{end}}')
oldconfig=$(docker inspect "$old" --format '{{range .Mounts}}{{if eq .Destination "/app/config"}}{{.Source}}{{end}}{{end}}')
test -d "$shared" && test -d "$media" && test -f "$wise/receiving.json"
test -z "$(find "$shared/jobs" -maxdepth 1 -name '*.lock' -print)"
test ! -e "$shared/.adapter.lock"
mkdir -p "$release/media-candidate" "$release/data-candidate/material-library" \
  "$release/private-candidate" "$release/config-candidate"
chmod 700 "$release/private-candidate" "$release/data-candidate"
cp -a "$media/." "$release/media-candidate/"
cp -a "$shared/." "$release/data-candidate/material-library/"
cp -a "$wise/receiving.json" "$release/private-candidate/receiving.json"
chmod 600 "$release/private-candidate/receiving.json"
test -s "$release/media-candidate/shusha/shusha-wordmark.svg"
cp "$release/source/deployment/config.shusha.json" "$release/config-candidate/default.json"
cp "$release/source/deployment/config.shusha.json" "$release/config-candidate/production.json"
python3 - "$oldconfig" "$release/config-candidate" <<'PY'
import json,sys,os
preserved={}
for filename in ["default.json","production.json"]:
    p=os.path.join(sys.argv[1],filename)
    if os.path.isfile(p): preserved.update(json.load(open(p)).get("system",{}).get("session",{}))
for filename in ["default.json","production.json"]:
    p=os.path.join(sys.argv[2],filename); data=json.load(open(p))
    if preserved: data["system"]["session"]=preserved
    with open(p,"w") as f: json.dump(data,f,indent=2)
    os.chmod(p,0o600)
PY
chmod 700 "$release/config-candidate"
docker inspect "$old" --format '{{json .Config.Env}}' | python3 -c '
import json,sys,os,secrets
old=dict(x.split("=",1) for x in json.load(sys.stdin))
# Carry only necessary application secrets, never image/build environment.
names=["DB_HOST","DB_PORT","DB_USER","DB_PASSWORD","COOKIE_SECRET","SESSION_SECRET",
       "JWT_ADMIN_SECRET","JWT_ADMIN_REFRESH_SECRET","JWT_CUSTOMER_SECRET","JWT_CUSTOMER_REFRESH_SECRET"]
new={key:old[key] for key in names if key in old}
new.update(DB_NAME=sys.argv[2],PORT="3000",TZ="Asia/Shanghai",NODE_ENV="production",
    EVERSHOP_HOME_URL="http://localhost:5444",PRIVATE_DATA_DIR="/app/data",
    MATERIAL_LIBRARY_DIR="/app/data/material-library",MATERIAL_MEDIA_DIR="/app/media/source-library",
    SOURCE_SYNC_BACKUP_DIR="/private/source-price-backups",
    SHUSHA_WISE_RECEIVING_CONFIG="/private/receiving.json",
    SUUSHA_PRICE_API_URL="https://suusha.com/Excel/api.php")
assert all(new.get(key) for key in ["DB_HOST","DB_USER","DB_PASSWORD"])
for key in ["JWT_ADMIN_SECRET","JWT_ADMIN_REFRESH_SECRET","JWT_CUSTOMER_SECRET","JWT_CUSTOMER_REFRESH_SECRET"]:
    if not new.get(key): new[key]=secrets.token_hex(32)
with open(sys.argv[1],"x") as f: f.write("".join(key+"="+value+"\n" for key,value in new.items()))
os.chmod(sys.argv[1],0o600)
' "$release/candidate.env" "$db"
docker exec "$pg" createdb -U postgres "$db"
docker exec -i "$pg" pg_restore -U postgres -d "$db" --exit-on-error < "$backup/database.dump"
docker create --name evershop-v2-candidate --network "$network" \
  --env-file "$release/candidate.env" --workdir /app --restart no \
  -p "$preview_host:5444:3000" \
  -v "$release/config-candidate:/app/config:ro" \
  -v "$release/private-candidate:/private" \
  -v "$release/data-candidate:/app/data" \
  -v "$release/media-candidate:/app/media" \
  "$image" sleep infinity
docker start evershop-v2-candidate
docker exec evershop-v2-candidate node deployment/capture-baseline.mjs --output /private/before.private.json
docker exec evershop-v2-candidate node deployment/migrate-v2.mjs
docker exec evershop-v2-candidate node deployment/adapt-store-content.mjs --apply --expected-database "$db"
docker exec evershop-v2-candidate node deployment/verify-baseline.mjs --baseline /private/before.private.json
printf 'Candidate restored, migrated and baseline-verified; jobs remain disabled.\n'
