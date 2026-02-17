# Zulip Claude Bot

A bot that listens for @-mentions in Zulip topics and responds using Claude
Code's Agent SDK. Claude has tool access (Read, Grep, Glob, Bash, WebSearch)
so it can answer technical questions about a codebase.

## Prerequisites

- Node.js 18+
- A Zulip server with a bot account
- Claude Code CLI installed and authenticated (`claude login`)

## Setup

### 1. Create a Zulip bot

1. Go to your Zulip organization's **Settings > Your bots**.
2. Click **Add a new bot**.
3. Choose **Generic bot** as the bot type.
4. Give it a name (e.g. "Claude") and save.
5. Download the `.zuliprc` file or note the bot's email and API key.

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your bot's credentials:

```bash
ZULIP_USERNAME=claude-bot@your-org.zulipchat.com
ZULIP_API_KEY=your-api-key-here
ZULIP_REALM=https://your-org.zulipchat.com
```

If you downloaded a `.zuliprc`, extract the values from it:

```ini
[api]
email=claude-bot@your-org.zulipchat.com   # -> ZULIP_USERNAME
key=abc123                                 # -> ZULIP_API_KEY
site=https://your-org.zulipchat.com        # -> ZULIP_REALM
```

### 3. Authenticate Claude

On the machine that will run the bot:

```bash
claude login
```

Follow the prompts to authenticate. The bot uses whichever Claude account
is active on the system.

### 4. Install and run

```bash
npm install
npm start
```

The bot will log its identity and start listening for events:

```
Starting Zulip Claude bot...
  Realm: https://your-org.zulipchat.com
  CWD:   /path/to/your/codebase
  Bot:   Claude (claude-bot@your-org.zulipchat.com)
Registered event queue: abc123
```

## Usage

@-mention the bot in any Zulip topic:

> @**Claude** What does the `handleMessage` function in `src/bot.ts` do?

The bot will:
1. Detect the mention via Zulip's event flags.
2. Fetch recent messages from the same topic for context.
3. Send the question to Claude with tool access to the codebase.
4. Post Claude's response in the same topic.

Messages without an @-mention are ignored. Direct messages are ignored
(only channel/stream messages are handled).

## Configuration

All configuration is via environment variables (or `.env` file).

| Variable | Required | Default | Description |
|---|---|---|---|
| `ZULIP_USERNAME` | Yes | | Bot's email address |
| `ZULIP_API_KEY` | Yes | | Bot's API key |
| `ZULIP_REALM` | Yes | | Zulip server URL |
| `CONTEXT_MESSAGES` | No | `20` | Number of recent topic messages to include as conversation context |
| `CLAUDE_MAX_TURNS` | No | `10` | Max agent turns per question (limits tool use loops) |
| `CLAUDE_CWD` | No | Current directory | Working directory for Claude's file tools |
| `CLAUDE_MODEL` | No | CLI default | Claude model to use (e.g. `claude-sonnet-4-5-20250929`) |

### Setting the working directory

`CLAUDE_CWD` controls which directory Claude's tools operate in. Set this to
the root of the codebase you want the bot to answer questions about:

```bash
CLAUDE_CWD=/home/user/projects/my-app
```

## Architecture

```
src/
  index.ts          Entry point: init, event queue registration, long-poll loop
  config.ts         Env config loading and validation
  zulip.ts          Zulip client wrapper (init, fetch messages, send with splitting)
  claude.ts         Claude Agent SDK wrapper (query with tools and context)
  bot.ts            Core logic: mention detection, context assembly, dispatch
  html-to-text.ts   Strip HTML from Zulip messages to plain text
```

### Event loop

The bot registers a Zulip event queue and long-polls for new events. Zulip's
long-polling blocks for ~90 seconds if there are no events, so no polling
interval is needed. If the queue expires (`BAD_EVENT_QUEUE_ID`), a new one is
registered automatically. Transient errors trigger a 5-second backoff before
retrying.

### Message handling

Each incoming mention is handled concurrently (fire-and-forget with error
catching). The bot:

1. Skips non-stream messages and its own messages.
2. Checks `event.flags` for `"mentioned"` (reliable server-side detection).
3. Strips HTML from the message content and removes `@mention` spans.
4. Fetches the last N messages from the same topic as conversation context.
5. Calls Claude via the Agent SDK with the question and context.
6. Posts the response. Messages over 9500 characters are split at paragraph
   boundaries (Zulip's limit is 10,000).
7. On error, posts a user-friendly error message to the topic.

### Claude tools

Claude has access to these tools in the codebase directory:

- **Read** - Read file contents
- **Grep** - Search file contents with regex
- **Glob** - Find files by name pattern
- **Bash** - Run shell commands
- **WebSearch** - Search the web

Permissions are bypassed (`permissionMode: "bypassPermissions"`) since the bot
runs unattended.

## Development

```bash
# Type check without emitting
npm run typecheck

# Build to dist/
npm run build

# Run directly with tsx (no build step needed)
npm start
```
