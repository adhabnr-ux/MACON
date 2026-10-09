FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY bin ./bin
COPY public ./public
# iputils-style ping is needed for status; busybox ping lacks -W semantics, so use iputils.
RUN apk add --no-cache iputils && addgroup -S macon && adduser -S macon -G macon
USER macon
ENV MACON_CONFIG=/data/macon.config.json
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "bin/macon.js", "start"]
