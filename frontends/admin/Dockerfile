FROM node:22-alpine
WORKDIR /app
COPY frontends/admin/package*.json ./
RUN npm ci
COPY frontends/admin/ ./
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]