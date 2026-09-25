FROM node:20.18.0-slim

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci

COPY --chown=node:node . .
RUN npm run build && \
    mkdir -p uploads && \
    chown -R node:node /app

USER 1000

EXPOSE 3000

CMD ["npm", "start"]
