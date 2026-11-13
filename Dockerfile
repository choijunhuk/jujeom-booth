FROM node:26-slim
WORKDIR /app
COPY --chown=node:node package.json server.js db.js menu.json rewards.json tables.json ./
COPY --chown=node:node public ./public
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data BASE_PATH=/booth
VOLUME /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+process.env.BASE_PATH+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
