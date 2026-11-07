FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

# Install dependencies matching base image
COPY package.json ./
RUN npm install

# Guarantee Chromium browser binaries match exactly
RUN npx playwright install chromium

# Copy source files
COPY . .

# Production environment variables
ENV NODE_ENV=production
ENV PORT=3005
ENV CHAOSBULL_HEADLESS=true
ENV CHAOSBULL_ALLOW_LOCAL=false

EXPOSE 3005

CMD ["npm", "start"]
