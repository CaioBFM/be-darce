FROM node:22-alpine AS dependencies
WORKDIR /app
COPY bffs/bff-admin/package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node bffs/bff-admin/package*.json ./
COPY --chown=node:node bffs/bff-admin/src ./src
USER node
EXPOSE 4001
CMD ["node", "src/index.js"]