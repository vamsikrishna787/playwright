# The Playwright image, because this application spawns the Playwright CLI and a
# headless Chromium — a slim Node base would build fine and then fail on the
# first run with a missing browser. The tag tracks the @playwright/test version
# in package.json; they have to move together.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY web web
# BASE_PATH is baked in: Next needs it at build time to rewrite its own links
# and assets, which is why it is the one setting the config layer does not own.
ARG BASE_PATH=""
ENV BASE_PATH=$BASE_PATH
RUN npm run build -w web

FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The profile to load from src/config. Override per environment.
ENV APP_ENV=prod

# Full node_modules rather than a traced subset: the Playwright and Lighthouse
# CLIs are spawned as child processes, so nothing in the bundle imports them and
# a tracer has no way to know they are needed.
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/web/.next web/.next
COPY web/package.json web/next.config.mjs web/server-bootstrap.mjs web/
# Read from disk at runtime: the profiles by the config layer, the runner config
# and reporter by the Playwright CLI.
COPY web/src/config web/src/config
COPY web/runtime web/runtime

WORKDIR /app/web
EXPOSE 5180

# Not `next start`: server-bootstrap.mjs wraps the Next handler in a server that
# can terminate TLS, and mutual TLS, when the profile asks for it.
CMD ["node", "server-bootstrap.mjs"]
