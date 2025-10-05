FROM node:20-alpine

WORKDIR /app
# ⬇️ FFmpeg för MP3→PCM
RUN apk add --no-cache ffmpeg

COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .

ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]
