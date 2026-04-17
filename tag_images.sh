#!/usr/bin/env bash

set -e
cd $(dirname "$0")

PUSH=no
eval set -- $(getopt --longoptions push -o '' -- "$@")

while [ $# -gt 0 ]; do
    case $1 in
    (--push)
        shift
        PUSH=yes
        ;;
    (--)
        shift
        break
        ;;
    esac
done

DEST_TAG="${1:-v1}"
SOURCE_TAG="${2:-latest}"

image_names() {
  yq -r '.services[].image | sub("^"; "echo ")' compose.yml | ISE_RECORD_TAG="$1" bash
}

while IFS= read -u 3 dest && IFS= read -u 4 src; do
    docker image tag "$src" "$dest"
done 3< <(image_names "$DEST_TAG") 4< <(image_names "$SOURCE_TAG")

if [ "$PUSH" == "yes" ]; then
    for img in $(image_names "$DEST_TAG"); do
	docker push "$img"
    done
fi
