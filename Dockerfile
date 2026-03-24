FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY src ./src

ENV DOCKER_ENV=true

EXPOSE 3001

CMD ["node", "src/index.js"]
