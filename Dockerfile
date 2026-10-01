FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
ENV PORT=80
ENV BIOSENSE_ALLOWED_ORIGINS=https://app.biosense.dev,https://biosense.dev,https://www.biosense.dev
EXPOSE 80 3000
CMD ["node", "src/api/server.js"]
