#!/bin/sh
# Writes version.json: a hash of everything the page loads. Run by the pre-commit hook.
cd "$(dirname "$0")"
h=$(cat style.css app.js data.enc.json assets/routes.json | shasum | cut -c1-10)
printf '{"v":"%s"}\n' "$h" > version.json
