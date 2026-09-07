FROM node:22.22.0-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3000
ENV OPENROUTER_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free

EXPOSE 3000

CMD ["node", "backend/server.js"]
