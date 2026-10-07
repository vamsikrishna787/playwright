# Worker Lambda image: Python handlers + Node tooling (Playwright Test, Playwright MCP, Lighthouse) + Chromium.
# Build context is the backend/ directory:  docker build -f worker/Dockerfile .
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS node

FROM public.ecr.aws/docker/library/python:3.12-slim-bookworm

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_APP=/opt/node-app \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_DEFAULT_TIMEOUT=120 \
    PIP_RETRIES=10 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Python dependencies. The toolchain is only there in case awslambdaric has to compile from source.
COPY worker/requirements.txt /tmp/requirements.txt
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ make cmake autoconf automake libtool \
 && (pip install -r /tmp/requirements.txt || (sleep 30 && pip install -r /tmp/requirements.txt)) \
 && apt-get purge -y g++ make cmake autoconf automake libtool \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /tmp/requirements.txt

# Node tooling + Chromium. @playwright/mcp pins its own playwright-core, so install the browser
# for every playwright-core copy in the tree.
WORKDIR /opt/node-app
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npx playwright install --with-deps chromium \
 && for cli in $(find node_modules -path '*/playwright-core/cli.js'); do node "$cli" install chromium; done \
 && node -e "console.log(require('playwright-core').chromium.executablePath())" > /opt/chrome-path \
 && test -x "$(cat /opt/chrome-path)" \
 && rm -rf /var/lib/apt/lists/* /root/.npm \
 && chmod -R a+rX /ms-playwright /opt/node-app /opt/chrome-path

WORKDIR /var/task
COPY src/ /var/task/
ENV HOME=/tmp PYTHONPATH=/var/task

ENTRYPOINT ["python", "-m", "awslambdaric"]
CMD ["app.worker.handler"]
