FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
USER 1000:1000
EXPOSE 8080
CMD ["node", "server.js"]
