FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=1000:1000 package*.json ./
RUN npm ci --omit=dev
COPY --chown=1000:1000 server.js ./
COPY --chown=1000:1000 public ./public
USER 1000:1000
EXPOSE 8080
CMD ["node", "server.js"]
