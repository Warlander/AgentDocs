#!/bin/sh
set -e
git config --global user.name "${GIT_USER_NAME:-Vault}"
git config --global user.email "${GIT_USER_EMAIL:-vault@localhost}"
git config --global --add safe.directory /vault
exec npm run start -w server
