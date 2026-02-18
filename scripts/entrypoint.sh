#!/usr/bin/env bash
set -e

# Ensure .claude dir and all contents are owned by bot (Docker volumes mount as root)
chown -R bot:bot /home/bot/.claude

# Drop to non-root user and exec the CMD
exec gosu bot "$@"