FROM node:22-alpine
WORKDIR /app
COPY frontends/portal/package*.json ./
RUN npm ci
COPY frontends/portal/ ./
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]