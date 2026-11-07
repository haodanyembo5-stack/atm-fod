FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY firebase-client.js ./
RUN npm run build:firebase

FROM node:24-alpine

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .
COPY --from=build --chown=node:node /app/public/firebase-client.js /app/public/firebase-client.js
RUN mkdir -p /app/data /app/uploads && chown -R node:node /app/data /app/uploads

VOLUME ["/app/data", "/app/uploads"]
EXPOSE 3000
USER node

CMD ["node", "server.mjs"]