FROM node:22.23.3-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY bench ./bench

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --retries=5 --start-period=5s CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(response => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"]

USER node
CMD ["node", "src/server/index.js"]
