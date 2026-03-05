# Node backend — Tesseract OCR runs inside Node via tesseract.js.
# Push to GitHub → Railway redeploys.

FROM node:20-bookworm-slim AS node-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app

# tesseract.js downloads its own WASM binary; no system packages needed for OCR
COPY --from=node-builder /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production

EXPOSE 4000

CMD ["node", "server.js"]
