/**
 * Serviço de integração com Telegram
 * Envia notificações formatadas para chats/grupos
 */

class TelegramService {

  /**
   * Enviar mensagem formatada
   */
  async enviarMensagem(botToken, chatId, notificacao) {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    const mensagemFormatada = this.formatarMensagem(notificacao);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: mensagemFormatada,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Telegram API error: ${error}`);
    }

    console.log(`[Telegram] Mensagem enviada para chat ${chatId}`);
    return true;
  }

  /**
   * Formatar mensagem para Telegram
   */
  formatarMensagem(notificacao) {
    const icones = {
      geofence_entrada: '📍',
      geofence_saida: '📤',
      excesso_velocidade: '🚨',
      alarme: '⚠️'
    };

    const severidadeIcones = {
      info: 'ℹ️',
      warning: '⚠️',
      danger: '🔴',
      critical: '🚨'
    };

    const icone = icones[notificacao.tipo] || severidadeIcones[notificacao.severidade] || '📢';
    const dados = notificacao.dados_extras
      ? (typeof notificacao.dados_extras === 'string' ? JSON.parse(notificacao.dados_extras) : notificacao.dados_extras)
      : {};

    let mensagem = `<b>${icone} ${this.escapeHtml(notificacao.titulo)}</b>\n\n`;
    mensagem += `${this.escapeHtml(notificacao.mensagem)}\n`;

    if (notificacao.dispositivo) {
      const dispositivo = notificacao.dispositivo;
      mensagem += `\n<b>Veículo:</b> ${this.escapeHtml(dispositivo.placa || dispositivo.imei)}`;
      if (dispositivo.veiculo) {
        mensagem += ` (${this.escapeHtml(dispositivo.veiculo)})`;
      }
    }

    if (dados.velocidade !== undefined) {
      mensagem += `\n<b>Velocidade:</b> ${dados.velocidade} km/h`;
    }

    if (dados.limite_velocidade) {
      mensagem += `\n<b>Limite:</b> ${dados.limite_velocidade} km/h`;
    }

    if (dados.excesso) {
      mensagem += `\n<b>Excesso:</b> +${dados.excesso} km/h`;
    }

    if (dados.geofence_nome) {
      mensagem += `\n<b>Cerca:</b> ${this.escapeHtml(dados.geofence_nome)}`;
    }

    if (dados.latitude && dados.longitude) {
      const mapUrl = `https://www.google.com/maps?q=${dados.latitude},${dados.longitude}`;
      mensagem += `\n\n<a href="${mapUrl}">📍 Ver no Mapa</a>`;
    }

    // Timestamp formatado para Brasil
    const dataFormatada = new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    mensagem += `\n\n<i>${dataFormatada}</i>`;

    return mensagem;
  }

  /**
   * Escape HTML para evitar problemas de parse
   */
  escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Validar configuração do bot (envia mensagem de teste)
   */
  async validarBot(botToken, chatId) {
    try {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '✅ <b>Bot configurado com sucesso!</b>\n\nVocê receberá notificações do sistema de rastreamento neste chat.\n\n<i>Unifique Rastreador GPS Tracking</i>',
          parse_mode: 'HTML'
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.description || 'Erro ao validar bot');
      }

      console.log(`[Telegram] Bot validado para chat ${chatId}`);
      return { sucesso: true, mensagem: 'Bot validado com sucesso! Mensagem de teste enviada.' };
    } catch (error) {
      console.error('[Telegram] Erro ao validar:', error.message);
      return { sucesso: false, mensagem: error.message };
    }
  }

  /**
   * Obter informações do bot
   */
  async getMe(botToken) {
    try {
      const url = `https://api.telegram.org/bot${botToken}/getMe`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error('Token inválido');
      }

      const data = await response.json();
      return data.result;
    } catch (error) {
      return null;
    }
  }

  /**
   * Obter atualizações do bot (para descobrir chat_id)
   */
  async getUpdates(botToken) {
    try {
      const url = `https://api.telegram.org/bot${botToken}/getUpdates?limit=10`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error('Erro ao buscar atualizações');
      }

      const data = await response.json();
      return data.result || [];
    } catch (error) {
      console.error('[Telegram] Erro ao buscar updates:', error.message);
      return [];
    }
  }
}

module.exports = new TelegramService();
