FROM node:20.18.1-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && mkdir -p /app/uploads && chown -R 1000:1000 /app

USER 1000

EXPOSE 3000

CMD ["npm", "start"]
