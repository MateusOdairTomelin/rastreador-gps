/**
 * Serviço de Criptografia - LGPD
 *
 * Criptografia de dados sensíveis (CPF, CNH, etc)
 * usando AES-256-GCM (autenticado)
 */

const crypto = require('crypto');

// Chave de criptografia deve estar no .env
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// Prefixo para identificar dados criptografados
const ENCRYPTED_PREFIX = 'ENC:';

class CryptoService {
  constructor() {
    // Derivar chave de 32 bytes a partir da chave fornecida
    this.key = crypto.scryptSync(ENCRYPTION_KEY, 'lgpd-salt', 32);

    if (!process.env.ENCRYPTION_KEY) {
      console.warn('[Crypto] ⚠️ ENCRYPTION_KEY não definida! Usando chave temporária. Configure ENCRYPTION_KEY no .env');
    }
  }

  /**
   * Criptografar um texto
   * @param {string} text - Texto para criptografar
   * @returns {string} - Texto criptografado em formato: ENC:iv:authTag:encrypted
   */
  encrypt(text) {
    if (!text || typeof text !== 'string') {
      return text;
    }

    // Se já está criptografado, retorna sem alterar
    if (text.startsWith(ENCRYPTED_PREFIX)) {
      return text;
    }

    try {
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);

      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      const authTag = cipher.getAuthTag();

      // Formato: ENC:iv:authTag:encrypted
      return `${ENCRYPTED_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
    } catch (error) {
      console.error('[Crypto] Erro ao criptografar:', error.message);
      return text;
    }
  }

  /**
   * Descriptografar um texto
   * @param {string} encryptedText - Texto criptografado
   * @returns {string} - Texto original
   */
  decrypt(encryptedText) {
    if (!encryptedText || typeof encryptedText !== 'string') {
      return encryptedText;
    }

    // Se não está criptografado, retorna sem alterar
    if (!encryptedText.startsWith(ENCRYPTED_PREFIX)) {
      return encryptedText;
    }

    try {
      const parts = encryptedText.slice(ENCRYPTED_PREFIX.length).split(':');
      if (parts.length !== 3) {
        console.error('[Crypto] Formato inválido de dados criptografados');
        return encryptedText;
      }

      const [ivHex, authTagHex, encrypted] = parts;
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');

      const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      console.error('[Crypto] Erro ao descriptografar:', error.message);
      return encryptedText;
    }
  }

  /**
   * Verificar se um texto está criptografado
   */
  isEncrypted(text) {
    return text && typeof text === 'string' && text.startsWith(ENCRYPTED_PREFIX);
  }

  /**
   * Mascarar CPF para exibição (ex: ***.***.***-00)
   */
  maskCPF(cpf) {
    if (!cpf) return null;
    const decrypted = this.decrypt(cpf);
    const clean = decrypted.replace(/\D/g, '');
    if (clean.length !== 11) return '***.***.***-**';
    return `***.***.***.${clean.slice(-2)}`;
  }

  /**
   * Mascarar CNH para exibição (ex: *******1234)
   */
  maskCNH(cnh) {
    if (!cnh) return null;
    const decrypted = this.decrypt(cnh);
    const clean = decrypted.replace(/\D/g, '');
    if (clean.length < 4) return '***********';
    return `${'*'.repeat(clean.length - 4)}${clean.slice(-4)}`;
  }

  /**
   * Mascarar telefone para exibição (ex: (47) *****-1234)
   */
  maskPhone(phone) {
    if (!phone) return null;
    const decrypted = this.decrypt(phone);
    const clean = decrypted.replace(/\D/g, '');
    if (clean.length < 4) return '(**) *****-****';
    return `(**) *****-${clean.slice(-4)}`;
  }

  /**
   * Criptografar campos sensíveis de um objeto motorista
   */
  encryptMotoristaFields(motorista) {
    if (!motorista) return motorista;

    const encrypted = { ...motorista };

    if (encrypted.cpf) {
      encrypted.cpf = this.encrypt(encrypted.cpf);
    }
    if (encrypted.cnh_numero) {
      encrypted.cnh_numero = this.encrypt(encrypted.cnh_numero);
    }
    if (encrypted.telefone) {
      encrypted.telefone = this.encrypt(encrypted.telefone);
    }

    return encrypted;
  }

  /**
   * Descriptografar campos sensíveis de um objeto motorista
   */
  decryptMotoristaFields(motorista) {
    if (!motorista) return motorista;

    const decrypted = { ...motorista };

    if (decrypted.cpf) {
      decrypted.cpf = this.decrypt(decrypted.cpf);
    }
    if (decrypted.cnh_numero) {
      decrypted.cnh_numero = this.decrypt(decrypted.cnh_numero);
    }
    if (decrypted.telefone) {
      decrypted.telefone = this.decrypt(decrypted.telefone);
    }

    return decrypted;
  }

  /**
   * Retornar motorista com campos mascarados (para listagem)
   */
  maskMotoristaFields(motorista) {
    if (!motorista) return motorista;

    return {
      ...motorista,
      cpf_masked: this.maskCPF(motorista.cpf),
      cnh_masked: this.maskCNH(motorista.cnh_numero),
      telefone_masked: this.maskPhone(motorista.telefone),
      // Remover dados sensíveis reais
      cpf: undefined,
      cnh_numero: undefined,
      telefone: undefined
    };
  }

  /**
   * Gerar uma nova chave de criptografia
   * (útil para configuração inicial)
   */
  static generateKey() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Calcular hash de senha para verificação
   * (não criptografia, apenas hash one-way)
   */
  hashPassword(password, salt = null) {
    const useSalt = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, useSalt, 100000, 64, 'sha512').toString('hex');
    return { hash, salt: useSalt };
  }

  /**
   * Verificar senha contra hash
   */
  verifyPassword(password, hash, salt) {
    const result = this.hashPassword(password, salt);
    return result.hash === hash;
  }
}

module.exports = new CryptoService();
