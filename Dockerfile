FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
ENV OPENROUTER_MODEL=deepseek/deepseek-chat-v3-0324:free

EXPOSE 3000

CMD ["node", "backend/server.js"]
