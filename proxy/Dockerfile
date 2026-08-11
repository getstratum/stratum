FROM node:20-alpine

WORKDIR /app

# Dependencies
COPY proxy/package.json ./
RUN npm install --production

# Source
COPY proxy/src/ ./src/

# DB migrations (needed by migrate.js)
COPY db/ ./db/

EXPOSE 8080
CMD ["node", "src/index.js"]
