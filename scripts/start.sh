#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Building and starting container..."
docker compose up --build -d

# Wait for the container to be running
container=$(docker compose ps -q bot)
if [ -z "$container" ]; then
  echo "Error: bot container failed to start." >&2
  docker compose logs bot
  exit 1
fi

# Check if claude credentials exist inside the container
if ! docker compose exec bot test -f /root/.claude/.credentials.json; then
  echo "No claude credentials found. Running claude login..."
  docker compose exec bot claude login
fi

echo "Bot is running. Use 'docker compose logs -f bot' to follow output."
