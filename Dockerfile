# Node 24 (Active LTS sedan 2025-10-28, se https://nodejs.org/en/about/previous-releases)
# + ffmpeg (ger även ffprobe). Alpine i stället för Debian: mindre image, färre kända
# CVE:er i basen. Inga av projektets npm-paket har native bindings, så musl libc
# (Alpines C-bibliotek, i stället för Debians glibc) kräver ingen extra
# kompilatorkedja här. Railway väljer denna framför Nixpacks/Railpack.
FROM node:24-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

# Chown once, on the still-empty directory (cheap), then switch user BEFORE
# installing - so npm ci writes node_modules as `node` directly. A `chown -R`
# AFTER copying in a full node_modules would create a whole extra image layer
# that duplicates every file just to change its owner (Docker layers are
# copy-on-write) - on this project that doubled to +124 MB for nothing.
RUN chown node:node /app
USER node

# npm ci, inte npm install: bygget ska få exakt de versioner som ligger i
# package-lock.json, inte nyare transitiva som aldrig granskats.
# --ignore-scripts: inget beroende här behöver ett install-script (geoip-lites
# databas ligger i tarballen), så vi kör inga.
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --chown=node:node . .

ENV HOST=0.0.0.0
ENV TRUST_PROXY=1
EXPOSE 8877

# Appen startar ffmpeg mot URL:er den fått utifrån. Kör inte det som root.
CMD ["npm", "start"]
