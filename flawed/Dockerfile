FROM node:latest AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY server.js ./
RUN mkdir -p /app/uploads && chown -R 1000:1000 /app
USER 1000:1000
EXPOSE 3000
CMD ["node", "server.js"]
