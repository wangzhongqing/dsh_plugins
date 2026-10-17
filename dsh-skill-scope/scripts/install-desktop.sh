#!/usr/bin/env bash
# Install skill-scope into the desktop profile.
#
# The desktop profile is owned by the Electron app: `dsh plugin` refuses to
# write it, and the app rewrites package.json on upgrade. This script does the
# two edits by hand, keeping timestamped backups, and is safe to re-run.
set -euo pipefail

PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PKG="@zhongqing/dsh-skill-scope"
STAMP="$(date +%Y%m%d-%H%M%S)"

[ -d "$PROFILE" ] || { echo "no desktop profile at $PROFILE" >&2; exit 1; }

cp "$PROFILE/package.json" "$PROFILE/package.json.bak-$STAMP"
cp "$PROFILE/cordis.patch.yml" "$PROFILE/cordis.patch.yml.bak-$STAMP"
echo "backed up to *.bak-$STAMP"

node - "$PROFILE/package.json" "$PLUGIN_DIR" "$PKG" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const [file, dir, pkg] = process.argv.slice(2)
const json = JSON.parse(readFileSync(file, 'utf8'))
json.dependencies ??= {}
json.dependencies[pkg] = `file:${dir}`
json.dsh ??= {}
json.dsh.profile ??= {}
json.dsh.profile.bundles ??= []
if (!json.dsh.profile.bundles.includes(pkg)) json.dsh.profile.bundles.push(pkg)
writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
console.log(`package.json: dependency + bundle added for ${pkg}`)
NODE

if ! grep -q "zhongqing-skill-scope" "$PROFILE/cordis.patch.yml"; then
  cat >> "$PROFILE/cordis.patch.yml" <<'YAML'
- insert:
    - id: zhongqing-skill-scope
      name: '@zhongqing/dsh-skill-scope'
      config:
        enabled: true
YAML
  echo "cordis.patch.yml: insert row added"
else
  echo "cordis.patch.yml: row already present"
fi

echo
echo "Next: restart DeepSeek Harness, then check the composer row for the \"技能 x/y\" pill."
