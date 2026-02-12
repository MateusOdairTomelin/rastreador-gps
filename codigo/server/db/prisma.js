const { PrismaClient } = require('@prisma/client');

// Singleton pattern to prevent multiple instances
let prisma;

if (process.env.NODE_ENV === 'production') {
  prisma = new PrismaClient();
} else {
  // In development, use a global variable to preserve the client across hot reloads
  if (!global.prisma) {
    global.prisma = new PrismaClient({
      log: ['error', 'warn'],  // Removido 'query' para melhorar performance
    });
  }
  prisma = global.prisma;
}

// Graceful shutdown handler
const disconnect = async () => {
  await prisma.$disconnect();
  console.log('✅ Database connection closed');
};

process.on('beforeExit', disconnect);
process.on('SIGINT', disconnect);
process.on('SIGTERM', disconnect);

module.exports = prisma;
