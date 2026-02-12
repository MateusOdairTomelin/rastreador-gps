/**
 * Utilitarios para datas
 */

import { format, parseISO, differenceInDays, isAfter, isBefore } from 'date-fns';
import { ptBR } from 'date-fns/locale';

/**
 * Formata data para exibicao (dd/MM/yyyy)
 */
export function formatDate(date: string | Date): string {
  const dateObj = typeof date === 'string' ? parseISO(date) : date;
  return format(dateObj, 'dd/MM/yyyy', { locale: ptBR });
}

/**
 * Formata data e hora para exibicao (dd/MM/yyyy HH:mm)
 */
export function formatDateTime(date: string | Date): string {
  const dateObj = typeof date === 'string' ? parseISO(date) : date;
  return format(dateObj, 'dd/MM/yyyy HH:mm', { locale: ptBR });
}

/**
 * Calcula status da CNH baseado na data de validade
 */
export function getCnhStatus(validade: string | Date | null | undefined): {
  status: 'valida' | 'vence_em_breve' | 'vencida' | 'nao_informada';
  diasRestantes: number | null;
  label: string;
  color: string;
} {
  if (!validade) {
    return {
      status: 'nao_informada',
      diasRestantes: null,
      label: 'Nao informada',
      color: '#9CA3AF', // gray
    };
  }

  const hoje = new Date();
  const dataValidade = typeof validade === 'string' ? parseISO(validade) : validade;
  const diasRestantes = differenceInDays(dataValidade, hoje);

  if (diasRestantes < 0) {
    return {
      status: 'vencida',
      diasRestantes,
      label: 'Vencida',
      color: '#EF4444', // red
    };
  }

  if (diasRestantes <= 30) {
    return {
      status: 'vence_em_breve',
      diasRestantes,
      label: `Vence em ${diasRestantes} dias`,
      color: '#F59E0B', // yellow/amber
    };
  }

  return {
    status: 'valida',
    diasRestantes,
    label: 'Valida',
    color: '#10B981', // green
  };
}

/**
 * Verifica se uma data ja passou
 */
export function isExpired(date: string | Date): boolean {
  const dateObj = typeof date === 'string' ? parseISO(date) : date;
  return isBefore(dateObj, new Date());
}

/**
 * Verifica se uma data esta no futuro
 */
export function isFuture(date: string | Date): boolean {
  const dateObj = typeof date === 'string' ? parseISO(date) : date;
  return isAfter(dateObj, new Date());
}
