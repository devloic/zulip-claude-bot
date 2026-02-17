#!/usr/bin/env bash
# Upload the spinner.gif as a custom emoji to Zulip.
# Usage: ./scripts/upload-emoji.sh
# Requires ZULIP_USERNAME, ZULIP_API_KEY, ZULIP_REALM in .env

set -euo pipefail
cd "$(dirname "$0")/.."

# Load .env
set -a; source .env; set +a

EMOJI_NAME="loading"
GIF_PATH="/tmp/spinner.gif"

if [ ! -f "$GIF_PATH" ]; then
  echo "Error: $GIF_PATH not found. Run the bot generator first."
  exit 1
fi

REALM="${ZULIP_REALM%/}"

echo "Uploading '$EMOJI_NAME' emoji to $REALM..."
curl -s -X POST "${REALM}/api/v1/realm/emoji/${EMOJI_NAME}" \
  -u "${ZULIP_USERNAME}:${ZULIP_API_KEY}" \
  -F "filename=@${GIF_PATH}" \
  | python3 -m json.tool

echo "Done."
