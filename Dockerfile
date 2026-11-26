# Earth music bot — Railway / Docker image
# Debian (glibc) base: @napi-rs/canvas (the now-playing card) ships Linux glibc binaries.
FROM oven/bun:1-debian

WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

# Set REGISTER_COMMANDS_ON_START=true for ONE deploy to (re)register slash commands.
# `exec` makes bun PID 1 so Railway's SIGTERM triggers the bot's graceful shutdown.
CMD ["sh", "-c", "if [ \"$REGISTER_COMMANDS_ON_START\" = \"true\" ]; then bun src/register-commands.ts || echo '[start] command registration failed — continuing'; fi; exec bun src/index.ts"]
