FROM node:22-slim

# claude CLI requires git and common shell tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/*

# Install claude CLI (needed by @anthropic-ai/claude-agent-sdk)
RUN npm install -g @anthropic-ai/claude-code

RUN useradd -m -s /bin/bash bot

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ src/
COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["npx", "tsx", "src/index.ts"]