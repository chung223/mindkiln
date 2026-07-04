FROM node:20-slim

# tar 已內建於 slim;備份功能需要它
WORKDIR /app

# 先裝相依(利用快取層)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# 資料放在容器內的 /data(部署時掛持久 volume 到這裡)
ENV NUWA_DATA_DIR=/data
ENV PORT=5723
VOLUME ["/data"]
EXPOSE 5723

# 容器內須綁 0.0.0.0 才能對外(本機直跑則預設綁 127.0.0.1)
ENV HOST=0.0.0.0
CMD ["node", "server/index.js"]
