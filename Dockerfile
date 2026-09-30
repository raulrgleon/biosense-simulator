FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
ENV PORT=80
ENV BIOSENSE_ALLOWED_ORIGINS=https://tuhoy.com,https://www.tuhoy.com
EXPOSE 80
CMD ["node", "src/api/server.js"]
