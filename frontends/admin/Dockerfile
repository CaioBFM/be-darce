FROM node:22-alpine AS build

WORKDIR /app

COPY frontends/admin/package*.json ./
RUN npm ci

COPY frontends/admin/ ./
RUN npm run build

FROM nginx:stable-alpine AS runtime

COPY frontends/admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
