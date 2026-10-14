FROM node:24-bookworm-slim AS node-runtime

FROM python:3.12-slim-bookworm
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
    && corepack enable \
    && pip install --no-cache-dir 'fastapi>=0.115,<1' 'pydantic>=2.10,<3' 'uvicorn>=0.34,<1' 'z3-solver>=4.13,<5'

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
ENV NODE_ENV=production
CMD ["bash", "scripts/start-railway.sh"]
