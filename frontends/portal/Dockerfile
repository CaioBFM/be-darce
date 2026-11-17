
FROM node:22-alpine AS build

WORKDIR /app

COPY frontends/portal/package*.json ./
RUN npm ci

COPY frontends/portal/ ./
RUN npm run build

FROM nginx:stable-alpine AS runtime

COPY frontends/portal/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
