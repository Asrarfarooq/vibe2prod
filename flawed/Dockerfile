FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY --chown=1000:1000 . .
RUN npm run build && mkdir -p uploads && chown -R 1000:1000 /app
USER 1000:1000
EXPOSE 3000
CMD ["npm", "start"]
