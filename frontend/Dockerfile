# -- Stage 1: Build React/Vite App
FROM node:20-alpine AS build

WORKDIR /app

# Install dependencies first for Docker layer caching
COPY package*.json ./
RUN npm install

# Build static files
COPY . .
RUN npm run build


# -- Stage 2: Lightweight Nginx Serve & Reverse Proxy
FROM nginx:alpine

# Remove default nginx HTML and Configuration
RUN rm -rf /etc/nginx/conf.d/*

# Inject custom hardened configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy compiled React front-end from Stage 1
COPY --from=build /app/dist /usr/share/nginx/html

# Only HTTP port exposed internally to compose
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
