FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3000
ENV OPENROUTER_MODEL=deepseek/deepseek-chat-v3-0324:free

EXPOSE 3000

CMD ["node", "backend/server.js"]
