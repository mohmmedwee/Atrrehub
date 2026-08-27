#!/usr/bin/env bash
# Build an offline installation bundle.
#
# An air-gapped install has no registry, no npm, and no way to pull an image at
# the moment somebody needs it. Everything the install needs therefore has to be
# in one file that crosses the boundary on physical media, and the manifest has
# to be checkable on the far side — a bundle you cannot verify is a bundle you
# cannot trust to install into a network with no way to re-download.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
OUT="${OUT:-dist/airgap}"
REGISTRY="${REGISTRY:-ghcr.io/atrrehub}"

# Images the chart references. Kept in step with values.yaml by the check below.
IMAGES=(
  "${REGISTRY}/api:${VERSION}"
  "${REGISTRY}/web:${VERSION}"
)
# Datastores an install without an existing cluster needs.
DEPENDENCIES=(
  "pgvector/pgvector:pg16"
  "redis:7-alpine"
)

usage() {
  cat <<USAGE
usage: package-airgap.sh [--skip-images]

  VERSION   image tag to bundle (default: version in package.json)
  REGISTRY  registry prefix to pull from (default: ghcr.io/atrrehub)
  OUT       output directory (default: dist/airgap)

Produces \$OUT/atrrehub-\$VERSION-airgap.tar.gz containing the container
images, the Helm chart, the database migrations and a manifest with a checksum
for each.
USAGE
}

SKIP_IMAGES=0
for arg in "$@"; do
  case "$arg" in
    --skip-images) SKIP_IMAGES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

CHART_VERSION=$(grep '^version:' infra/helm/atrrehub/Chart.yaml | awk '{print $2}')
VALUES_TAG=$(grep -A5 '^image:' infra/helm/atrrehub/values.yaml | grep 'tag:' | tr -d " '\"" | cut -d: -f2)
if [ "$VALUES_TAG" != "$VERSION" ]; then
  # A bundle whose images and chart disagree installs a version nobody chose,
  # and does it on the far side of an air gap where nobody can correct it.
  echo "Refusing: values.yaml pins image tag '$VALUES_TAG' but this bundle is '$VERSION'." >&2
  echo "Update infra/helm/atrrehub/values.yaml, or set VERSION=$VALUES_TAG." >&2
  exit 1
fi

STAGE="$OUT/atrrehub-$VERSION"
rm -rf "$STAGE"
mkdir -p "$STAGE/images" "$STAGE/chart" "$STAGE/migrations"

echo "Packaging Atrrehub $VERSION (chart $CHART_VERSION) into $STAGE"

# ── Images ───────────────────────────────────────────────────────────────────

if [ "$SKIP_IMAGES" = "1" ]; then
  echo "Skipping images (--skip-images)."
else
  command -v docker >/dev/null || { echo "docker is required to bundle images" >&2; exit 1; }
  for image in "${IMAGES[@]}" "${DEPENDENCIES[@]}"; do
    file="$STAGE/images/$(echo "$image" | tr '/:' '__').tar"
    echo "  pulling $image"
    docker pull --quiet "$image" >/dev/null
    # Saved uncompressed here; the whole bundle is compressed once at the end,
    # which deduplicates far better than compressing each layer twice.
    docker save "$image" -o "$file"
  done
fi

# ── Chart, migrations and schema ─────────────────────────────────────────────

cp -r infra/helm/atrrehub/. "$STAGE/chart/"
cp -r apps/api/prisma/migrations/. "$STAGE/migrations/"
cp apps/api/prisma/schema.prisma "$STAGE/migrations/schema.prisma"
cp -r infra/sql "$STAGE/sql"

# ── Install instructions that work with no network ───────────────────────────

cat > "$STAGE/INSTALL.md" <<INSTALL
# Atrrehub $VERSION — offline install

Chart version $CHART_VERSION. Nothing here reaches the internet.

## 1. Verify the bundle

\`\`\`bash
sha256sum -c MANIFEST.sha256
\`\`\`

Do this before anything else. On the far side of an air gap there is no way to
re-download a file that arrived corrupt.

## 2. Load the images

\`\`\`bash
for tar in images/*.tar; do docker load -i "\$tar"; done
\`\`\`

Then retag and push them to the internal registry:

\`\`\`bash
INTERNAL=registry.internal.example/atrrehub
for image in api web; do
  docker tag $REGISTRY/\$image:$VERSION \$INTERNAL/\$image:$VERSION
  docker push \$INTERNAL/\$image:$VERSION
done
\`\`\`

## 3. Prepare the database

The API image runs migrations through a Helm hook, so this is only needed when
the database is provisioned separately:

\`\`\`bash
psql "\$DATABASE_URL" -f sql/init/01-extensions.sql
\`\`\`

\`pgvector\` must be installable. It is the one dependency an air-gapped Postgres
has to have built in — the platform cannot function without vector search.

## 4. Install

\`\`\`bash
helm install atrrehub ./chart \\
  --namespace atrrehub --create-namespace \\
  --set image.registry=registry.internal.example \\
  --set image.repository=atrrehub \\
  --set config.aiDefaultProvider=local \\
  --set-string secrets.databaseUrl="\$DATABASE_URL" \\
  --set-string secrets.redisUrl="\$REDIS_URL" \\
  --set-string secrets.jwtSecret="\$(openssl rand -hex 32)" \\
  --set-string secrets.encryptionKey="\$(openssl rand -hex 32)" \\
  --set-string secrets.widgetTokenSecret="\$(openssl rand -hex 32)"
\`\`\`

\`aiDefaultProvider=local\` matters: the bundled local provider is the only one
that works without egress. OpenAI and Anthropic routes will fail on an
air-gapped network, and the governance policy should list \`local\` as the only
allowed provider so nobody configures one that cannot be reached.

Keep \`encryptionKey\` safe. It decrypts channel credentials, webhook signing
secrets and integration tokens; losing it means re-entering every one of them.

## What is not in this bundle

- TLS certificates. Supply your own.
- A Postgres or Redis operator. The images are here; how you run them is yours.
- Any AI model weights beyond what the local provider ships with.
INSTALL

# ── Manifest ─────────────────────────────────────────────────────────────────

( cd "$STAGE" && find . -type f ! -name 'MANIFEST.sha256' -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256 )

cat > "$STAGE/BUNDLE.json" <<JSON
{
  "version": "$VERSION",
  "chartVersion": "$CHART_VERSION",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "images": $(printf '%s\n' "${IMAGES[@]}" "${DEPENDENCIES[@]}" | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))'),
  "migrations": $(ls apps/api/prisma/migrations | grep -c '^[0-9]'),
  "files": $(find "$STAGE" -type f | wc -l)
}
JSON

ARCHIVE="$OUT/atrrehub-$VERSION-airgap.tar.gz"
tar -czf "$ARCHIVE" -C "$OUT" "atrrehub-$VERSION"
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"

echo
echo "Bundle:   $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
echo "Checksum: $(cut -d' ' -f1 < "$ARCHIVE.sha256")"
echo "Contents: $(find "$STAGE" -type f | wc -l) files, $(ls "$STAGE/images" 2>/dev/null | wc -l) images, $(ls apps/api/prisma/migrations | grep -c '^[0-9]') migrations"
