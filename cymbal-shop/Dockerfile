FROM node:24 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8000

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY server.js ./
COPY public ./public

RUN mkdir -p /app/uploads && chown -R 1000:1000 /app
USER 1000:1000

EXPOSE 8000
CMD ["npm", "start"]
