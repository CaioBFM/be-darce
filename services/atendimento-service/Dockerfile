FROM node:22-alpine AS dependencies
WORKDIR /app
COPY services/atendimento-service/package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node services/atendimento-service/package*.json ./
COPY --chown=node:node services/atendimento-service/src ./src
USER node
EXPOSE 5001
CMD ["node", "src/index.js"]