FROM node:24-slim

WORKDIR /app

# hadolint ignore=DL3008
RUN apt-get update && \
    apt-get install -y --no-install-recommends zip && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && \
    mkdir -p uploads && \
    chown -R 1000:1000 /app

USER 1000:1000

EXPOSE 8000

ENV PORT=8000

CMD ["npm", "start"]
