#!/usr/bin/env bash
set -e

# Ensure .claude.json config exists for bot user (claude CLI requires it)
if [ ! -f /home/bot/.claude.json ]; then
  echo '{}' > /home/bot/.claude.json
fi

# Ensure .claude dir and all contents are owned by bot (Docker volumes mount as root)
chown -R bot:bot /home/bot/.claude /home/bot/.claude.json

# Ensure data directory exists and is owned by bot (for SQLite database)
mkdir -p /data
chown bot:bot /data

# Drop to non-root user and exec the CMD
exec gosu bot "$@"