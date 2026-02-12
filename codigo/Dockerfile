# Dockerfile para Sistema de Rastreamento Veicular
# Usando Debian slim para maior compatibilidade com módulos nativos
FROM node:18-slim

# Instalar dependências do sistema
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    postgresql-client \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Criar diretório da aplicação
WORKDIR /app

# Copiar arquivos de dependências
COPY package*.json ./
COPY prisma ./prisma/

# Instalar dependências
RUN npm ci --only=production

# Gerar cliente Prisma
RUN npx prisma generate

# Copiar código da aplicação
COPY server ./server/
COPY public ./public/

# Criar diretório de logs e ajustar permissões
RUN mkdir -p logs data && chown -R node:node /app

# Usar usuário não-root (segurança)
USER node

# Expor portas
# 62000 = HTTP/WebSocket
# 8877 = TCP XT40_4F (Cabo)
# 8878 = TCP XT40_OBD2
EXPOSE 62000 8877 8878

# Variáveis de ambiente padrão
ENV NODE_ENV=production
ENV API_PORT=62000
ENV HTTP_PORT=62000
ENV TCP_PORT=8877

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:62000/api/status || exit 1

# Comando para iniciar
CMD ["node", "server/index.js"]
