# Obsideo MCP server — stdio transport. Containerized so isolated runners
# (e.g. Glama's introspection check) can start it and list its tools without a
# local Node toolchain. Speaks MCP over stdio; credentials are read from the
# user's config at call time, so the image itself holds no secrets.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# stdio server: no ports, no daemon. The MCP client drives it over stdin/stdout.
ENTRYPOINT ["node", "dist/index.js"]
