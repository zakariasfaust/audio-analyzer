# Node 18 + ffmpeg (ger även ffprobe). Railway väljer denna framför Nixpacks/Railpack.
FROM node:18-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV HOST=0.0.0.0
EXPOSE 8877
CMD ["npm", "start"]
