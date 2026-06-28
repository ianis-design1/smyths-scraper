FROM node:20-slim

WORKDIR /app

# Install Playwright dependencies
RUN npx playwright install --with-deps chromium

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3001
CMD ["node", "index.js"]
