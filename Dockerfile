FROM node:22-slim

# claude CLI requires git and common shell tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install claude CLI (needed by @anthropic-ai/claude-agent-sdk)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ src/

CMD ["npx", "tsx", "src/index.ts"]
