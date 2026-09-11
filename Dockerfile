FROM node:24-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY --chown=node:node public ./public
COPY --chown=node:node server ./server

USER node

EXPOSE 3000

CMD ["npm", "start"]