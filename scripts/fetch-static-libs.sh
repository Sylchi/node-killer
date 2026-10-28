#!/bin/sh
# Download the static C libraries that qnode links into the binary.
#
# Alpine ships static archives in separate packages (zlib-static,
# openssl-libs-static) that are not pulled in by the -dev packages. Versions
# must match the installed headers, so derive them from apk when possible.
set -eu

cd "$(dirname "$0")/.."
dest="vendor/static"
mkdir -p "$dest"
cd "$dest"

repover="v3.24"
arch="x86_64"
base="https://dl-cdn.alpinelinux.org/alpine/$repover/main/$arch"

zlib_ver="${ZLIB_STATIC_VERSION:-1.3.2-r1}"
openssl_ver="${OPENSSL_STATIC_VERSION:-3.5.9-r0}"

for pkg in "zlib-static-$zlib_ver" "openssl-libs-static-$openssl_ver"; do
    if [ ! -f "usr/lib/$(echo "$pkg" | sed 's/-[0-9].*//').a" ]; then
        echo "fetching $pkg"
        curl -sSLO "$base/$pkg.apk"
        tar -xzf "$pkg.apk"
        rm -f "$pkg.apk"
    fi
done

echo "static libraries in $dest/usr/lib"
ls -1 usr/lib/*.a
