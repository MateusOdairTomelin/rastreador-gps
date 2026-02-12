/**
 * Utilitarios para CPF
 * - Validacao de digitos verificadores
 * - Formatacao com mascara
 */

/**
 * Remove caracteres nao numericos do CPF
 */
export function cleanCPF(cpf: string): string {
  return cpf.replace(/\D/g, '');
}

/**
 * Formata CPF com mascara (xxx.xxx.xxx-xx)
 */
export function formatCPF(cpf: string): string {
  const cleaned = cleanCPF(cpf);

  if (cleaned.length <= 3) {
    return cleaned;
  }

  if (cleaned.length <= 6) {
    return `${cleaned.slice(0, 3)}.${cleaned.slice(3)}`;
  }

  if (cleaned.length <= 9) {
    return `${cleaned.slice(0, 3)}.${cleaned.slice(3, 6)}.${cleaned.slice(6)}`;
  }

  return `${cleaned.slice(0, 3)}.${cleaned.slice(3, 6)}.${cleaned.slice(6, 9)}-${cleaned.slice(9, 11)}`;
}

/**
 * Valida os digitos verificadores do CPF
 */
export function validateCPF(cpf: string): boolean {
  const cleaned = cleanCPF(cpf);

  // Deve ter 11 digitos
  if (cleaned.length !== 11) {
    return false;
  }

  // Nao pode ser sequencia repetida
  if (/^(\d)\1{10}$/.test(cleaned)) {
    return false;
  }

  // Calcular primeiro digito verificador
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(cleaned.charAt(i)) * (10 - i);
  }
  let remainder = sum % 11;
  let digit1 = remainder < 2 ? 0 : 11 - remainder;

  if (digit1 !== parseInt(cleaned.charAt(9))) {
    return false;
  }

  // Calcular segundo digito verificador
  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(cleaned.charAt(i)) * (11 - i);
  }
  remainder = sum % 11;
  let digit2 = remainder < 2 ? 0 : 11 - remainder;

  if (digit2 !== parseInt(cleaned.charAt(10))) {
    return false;
  }

  return true;
}

/**
 * Verifica se o CPF tem formato valido (mesmo sem validar digitos)
 */
export function hasValidCPFFormat(cpf: string): boolean {
  const cleaned = cleanCPF(cpf);
  return cleaned.length === 11;
}
