FROM node:20-alpine

WORKDIR /app

COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=10000

EXPOSE 10000

CMD ["node", "server.js"]
