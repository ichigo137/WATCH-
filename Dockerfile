FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public
EXPOSE 3000
CMD ["npm", "start"]
