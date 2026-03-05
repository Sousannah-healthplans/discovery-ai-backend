#!/bin/sh
# Start Node server (Tesseract OCR runs in-process via tesseract.js)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec node server.js
