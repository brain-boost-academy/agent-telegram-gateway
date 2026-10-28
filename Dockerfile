# syntax=docker/dockerfile:1
# Final state: the protocol dependency is the GitHub release tgz URL pinned in package.json/package-lock.json (D13),
# so a plain `npm ci` works from the build context.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080 8081
# admin CLI in the same image: docker run … node dist/admin/main.js connectors create <name>
CMD ["node", "dist/main.js"]
