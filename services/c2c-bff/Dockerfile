FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
COPY src ./src
RUN npm install
RUN npm run build
RUN npm run test

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
EXPOSE 8090
CMD ["node", "dist/index.js"]
