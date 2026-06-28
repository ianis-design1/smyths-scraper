#!/bin/bash
# Start script for Smyths Playwright Service
# Used for Render / Railway / Docker

set -e

echo "Installing Playwright browsers..."
npx playwright install --with-deps chromium 2>&1 || echo "Playwright install skipped (may be cached)"

echo "Starting service..."
node index.js
