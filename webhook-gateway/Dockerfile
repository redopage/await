FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY forward.mjs server.mjs ./
USER node
ENV PORT=8789
EXPOSE 8789
CMD ["node", "server.mjs"]
