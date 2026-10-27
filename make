#!/bin/bash

APPNAME="tvaplay"
APPNAME_LOWER="${APPNAME,,}"
APPLINK=http://github.com/unidiag/tvaplay


if [ "$1" = "clean" ]; then
    echo "Cleaning build files..."

    rm -f "./$APPNAME_LOWER"
    rm -f "./$APPNAME_LOWER.db"
    rm -f ./*.sqlite3 2>/dev/null

    echo "Done."
    exit 0
fi


# get current version from main.go
CUR_VERSION=$(grep -oP 'const VERSION = "\K[0-9]+\.[0-9]+' main.go)

# increment version (0.01)
NEW_VERSION=$(LC_NUMERIC=C awk "BEGIN {printf \"%.2f\", $CUR_VERSION + 0.01}")

DATE=$(date +"%Y-%m-%d")
TIME=$(date +"%H:%M:%S")
UNIX=$(date +%s)

echo "Old version: $CUR_VERSION"
echo "New version: $NEW_VERSION"


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

echo '####################################'

go build -ldflags "-linkmode external -extldflags '-static'" -o $APPNAME_LOWER


if [ "$1" = "run" ]; then
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
