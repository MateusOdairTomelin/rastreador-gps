#!/usr/bin/env node

/**
 * Script de Migração LGPD - Criptografar dados sensíveis de motoristas
 *
 * Este script criptografa CPF, CNH e telefone de todos os motoristas existentes
 * que ainda não estão criptografados.
 *
 * Uso: node scripts/migrate-encrypt-motoristas.js
 */

require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');

const prisma = new PrismaClient();

// Configuração de criptografia (mesmo do crypto.service.js)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const ENCRYPTED_PREFIX = 'ENC:';

if (!ENCRYPTION_KEY) {
  console.error('❌ ENCRYPTION_KEY não definida no .env');
  process.exit(1);
}

const key = crypto.scryptSync(ENCRYPTION_KEY, 'lgpd-salt', 32);

function encrypt(text) {
  if (!text || typeof text !== 'string') return text;
  if (text.startsWith(ENCRYPTED_PREFIX)) return text; // Já criptografado

  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `${ENCRYPTED_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  } catch (error) {
    console.error('Erro ao criptografar:', error.message);
    return text;
  }
}

function isEncrypted(text) {
  return text && typeof text === 'string' && text.startsWith(ENCRYPTED_PREFIX);
}

async function migrateMotoristas() {
  console.log('🔐 Iniciando migração de criptografia LGPD para motoristas...\n');

  try {
    // Buscar todos os motoristas
    const motoristas = await prisma.motorista.findMany({
      select: {
        id: true,
        nome: true,
        cpf: true,
        cnh_numero: true,
        telefone: true
      }
    });

    console.log(`📊 Total de motoristas encontrados: ${motoristas.length}\n`);

    let migrados = 0;
    let jaEncriptados = 0;
    let erros = 0;

    for (const motorista of motoristas) {
      let precisaMigrar = false;
      const updates = {};

      // Verificar CPF
      if (motorista.cpf && !isEncrypted(motorista.cpf)) {
        updates.cpf = encrypt(motorista.cpf);
        precisaMigrar = true;
      }

      // Verificar CNH
      if (motorista.cnh_numero && !isEncrypted(motorista.cnh_numero)) {
        updates.cnh_numero = encrypt(motorista.cnh_numero);
        precisaMigrar = true;
      }

      // Verificar Telefone
      if (motorista.telefone && !isEncrypted(motorista.telefone)) {
        updates.telefone = encrypt(motorista.telefone);
        precisaMigrar = true;
      }

      if (precisaMigrar) {
        try {
          await prisma.motorista.update({
            where: { id: motorista.id },
            data: updates
          });
          console.log(`✅ Motorista ${motorista.id} (${motorista.nome}) - dados criptografados`);
          migrados++;
        } catch (err) {
          console.error(`❌ Erro ao migrar motorista ${motorista.id}: ${err.message}`);
          erros++;
        }
      } else {
        jaEncriptados++;
      }
    }

    console.log('\n📊 Resultado da migração:');
    console.log(`   ✅ Migrados: ${migrados}`);
    console.log(`   🔐 Já criptografados: ${jaEncriptados}`);
    console.log(`   ❌ Erros: ${erros}`);
    console.log(`   📋 Total: ${motoristas.length}`);

  } catch (error) {
    console.error('❌ Erro fatal na migração:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Executar
migrateMotoristas()
  .then(() => {
    console.log('\n✨ Migração concluída!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Erro:', error);
    process.exit(1);
  });
