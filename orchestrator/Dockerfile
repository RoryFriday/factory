FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim

# Install git CLI -- required by simple-git for clone/pull operations
# when SOURCE_CONTROL_ENABLED=true. Harmless when the flag is off.
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

CMD ["node", "dist/main.js"]