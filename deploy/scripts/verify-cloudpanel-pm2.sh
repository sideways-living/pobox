#!/usr/bin/env bash
set -euo pipefail
export PM2_NAME="${PM2_NAME:-pobox-watch-api}"
export RELEASE_DIR="${RELEASE_DIR:-$(cat "${RELEASES_DIR:-/home/pobox/releases/pobox.watch}/last-successful-release")}"
cd "$RELEASE_DIR"
export DEPLOY_COMMIT="${DEPLOY_COMMIT:-$(node -p "require('./web/dist/deployment.json').commit")}"
export APP_PORT="${APP_PORT:-4175}"
export SITE_URL="${SITE_URL:-https://pobox.watch}"
pm2 jlist | node -e '
let text="";process.stdin.on("data",d=>text+=d);process.stdin.on("end",()=>{
 const apps=JSON.parse(text).filter(a=>a.name===process.env.PM2_NAME);
 if(apps.length!==1 || apps[0].pm2_env.status!=="online" || apps[0].pm2_env.pm_cwd!==process.env.RELEASE_DIR || apps[0].pm2_env.pm_exec_path!==process.env.RELEASE_DIR+"/server/dist/src/index.js") {
 console.error("PM2 process status/path does not match selected release");process.exit(1);
 }
});'
node deploy/scripts/verify-release.mjs
