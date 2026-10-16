FROM node:20-alpine
WORKDIR /app
COPY alerta.js ./
USER node
CMD ["node", "alerta.js", "--servico"]
