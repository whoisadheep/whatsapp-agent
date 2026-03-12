FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --production

COPY src ./src
COPY .env ./.env

ENV DOCKER_ENV=true

EXPOSE 3001

CMD ["node", "src/index.js"]
