#!/bin/bash

set -euo pipefail

APPNAME="TVAPLAY"
APPNAME_LOWER="${APPNAME,,}"
APPLINK=https://tvaplay.com


if [ "${1:-}" = "clean" ]; then
    echo "Cleaning build files..."

    rm -f "./$APPNAME_LOWER"
    rm -f "./$APPNAME_LOWER.db"
    rm -f ./*.sqlite3 2>/dev/null

    echo "Done."
    exit 0
fi


# Get current version from main.go
CUR_VERSION=$(grep -oP 'const VERSION = "\K[0-9]+\.[0-9]+' main.go)

# Keep current version by default
NEW_VERSION="$CUR_VERSION"
IS_NEW_VERSION=false

# Increment version only if "new" argument is specified
if [[ " $* " == *" new "* ]]; then
    IS_NEW_VERSION=true
    NEW_VERSION=$(LC_NUMERIC=C awk "BEGIN {printf \"%.2f\", $CUR_VERSION + 0.01}")
fi

DATE=$(date +"%Y-%m-%d")
TIME=$(date +"%H:%M:%S")
UNIX=$(date +%s)

if [ "$CUR_VERSION" != "$NEW_VERSION" ]; then
    echo "Version upgrade: $CUR_VERSION -> $NEW_VERSION"
else
    echo "Version unchanged: $CUR_VERSION"
fi

echo "Build date: $DATE"
echo "Build time: $TIME"


sed -i "s|const APPNAME = \".*\".*|const APPNAME = \"$APPNAME\"|g" main.go
sed -i "s|const APPLINK = \".*\".*|const APPLINK = \"$APPLINK\"|g" main.go
sed -i "s|const VERSION = \".*\".*|const VERSION = \"$NEW_VERSION\"|g" main.go
sed -i "s|const BUILD_DATE = \".*\".*|const BUILD_DATE = \"$DATE\"|g" main.go
sed -i "s|const BUILD_TIME = \".*\".*|const BUILD_TIME = \"$TIME\"|g" main.go

cd ./frontend/

sed -i "s|REACT_APP_NAME *=.*|REACT_APP_NAME = $APPNAME|g" .env
sed -i "s|REACT_APP_VERSION *=.*|REACT_APP_VERSION = $NEW_VERSION|g" .env
sed -i "s|REACT_APP_LINK *=.*|REACT_APP_LINK = $APPLINK|g" .env
sed -i "s|BUILD_UNIX *=.*|BUILD_UNIX = $UNIX|g" .env

npm run build

cd ../


#go build -ldflags "-linkmode external -extldflags '-static'" -o $APPNAME_LOWER


CGO_ENABLED=1 go build \
    -trimpath \
    -buildvcs=false \
    -ldflags="-s -w -buildid= -linkmode external -extldflags '-static'" \
    -o "$APPNAME_LOWER" . || exit 1

# Publish release binary
DOWNLOAD_DIR="/TVAPLAY.COM/download"
DOWNLOAD_FILE="$DOWNLOAD_DIR/${APPNAME_LOWER}_v${NEW_VERSION}"

mkdir -p "$DOWNLOAD_DIR" || exit 1

echo "Publishing binary: $DOWNLOAD_FILE"

# Atomic binary publication
TEMP_FILE="${DOWNLOAD_FILE}.tmp"

cp -f "./$APPNAME_LOWER" "$TEMP_FILE" || exit 1
chmod 755 "$TEMP_FILE" || exit 1
mv -f "$TEMP_FILE" "$DOWNLOAD_FILE" || exit 1

echo "Binary published successfully:"
ls -lh "$DOWNLOAD_FILE"


# Create changelog for a new release
if [ "$IS_NEW_VERSION" = true ]; then

    CHANGELOG_FILE="$DOWNLOAD_DIR/changelog_v${NEW_VERSION}.txt"

    # Create changelog template if it does not exist
    if [ ! -f "$CHANGELOG_FILE" ]; then
        cat > "$CHANGELOG_FILE" <<EOF
- 

EOF
    fi

    echo "Editing changelog: $CHANGELOG_FILE"

    mcedit "$CHANGELOG_FILE"

    chmod 644 "$CHANGELOG_FILE"

    echo "Changelog saved:"
    ls -lh "$CHANGELOG_FILE"

fi


# echo '############# GARBLE ####################'

# GARBLE="$(go env GOPATH)/bin/garble"
# OUTPUT="$(pwd)/$APPNAME_LOWER"

# echo "Building: $OUTPUT"

# if [ ! -x "$GARBLE" ]; then
#     echo "ERROR: Garble not found: $GARBLE"
#     exit 1
# fi

# CGO_ENABLED=1 "$GARBLE" -literals build \
#     -trimpath \
#     -buildvcs=false \
#     -ldflags="-s -w -linkmode external -extldflags '-static'" \
#     -o "$OUTPUT" .

# if [ $? -ne 0 ]; then
#     echo "ERROR: Garble build failed!"
#     exit 1
# fi

# if [ ! -f "$OUTPUT" ]; then
#     echo "ERROR: Binary not found: $OUTPUT"
#     exit 1
# fi

# echo "Build successful: $OUTPUT"
# ls -lh "$OUTPUT"






if [[ " $* " == *" run "* ]]; then
    echo "Running binary..."
    ./$APPNAME_LOWER
    exit 0
fi

git checkout --orphan new-main
git add -A
git commit -m "Initial"
git branch -D main
git branch -m main
git push -f origin main

echo "Restart $APPNAME_LOWER.service..."
sudo -n /usr/bin/systemctl restart "$APPNAME_LOWER.service"
