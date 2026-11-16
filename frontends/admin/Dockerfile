FROM node:22-alpine AS build
WORKDIR /app
COPY frontends/admin/package*.json ./
RUN npm ci
COPY frontends/admin/ ./
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY frontends/admin/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80