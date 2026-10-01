FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
USER node
EXPOSE 8080
CMD ["node", "server.js"]
