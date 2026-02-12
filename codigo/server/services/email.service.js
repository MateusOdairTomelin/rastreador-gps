/**
 * Serviço de Email
 * Configurado via variáveis de ambiente:
 * - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 * - EMAIL_FROM (remetente padrão)
 * - APP_URL (URL base da aplicação)
 */

const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    this.transporter = null;
    this.isConfigured = false;
    this.fromEmail = process.env.EMAIL_FROM || 'noreply@unifique.com.br';
    this.appUrl = process.env.APP_URL || 'http://localhost:62000';

    this.init();
  }

  init() {
    const host = process.env.SMTP_HOST;
    const port = process.env.SMTP_PORT;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (host && port && user && pass) {
      try {
        this.transporter = nodemailer.createTransport({
          host,
          port: parseInt(port),
          secure: parseInt(port) === 465,
          auth: {
            user,
            pass
          }
        });
        this.isConfigured = true;
        console.log('📧 Serviço de email configurado com sucesso');
      } catch (error) {
        console.warn('⚠️ Erro ao configurar serviço de email:', error.message);
      }
    } else {
      console.warn('⚠️ Serviço de email não configurado. Configure SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS');
    }
  }

  /**
   * Enviar email
   */
  async send(to, subject, html, text = null) {
    if (!this.isConfigured) {
      console.log('📧 [EMAIL NÃO CONFIGURADO] Para:', to);
      console.log('   Assunto:', subject);
      console.log('   Conteúdo:', text || html);
      return { success: true, simulated: true };
    }

    try {
      const result = await this.transporter.sendMail({
        from: this.fromEmail,
        to,
        subject,
        html,
        text: text || html.replace(/<[^>]*>/g, '')
      });

      console.log('📧 Email enviado para:', to);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('❌ Erro ao enviar email:', error.message);
      throw new Error('Falha ao enviar email');
    }
  }

  /**
   * Enviar email de recuperação de senha
   */
  async sendPasswordReset(email, nome, token) {
    const resetUrl = `${this.appUrl}/reset-password.html?token=${token}`;

    const subject = 'Recuperação de Senha - Unifique Rastreador';

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7fa;">
        <table cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <tr>
            <td style="background: linear-gradient(135deg, #131E7D 0%, #212492 50%, #00A2FF 100%); padding: 30px; border-radius: 16px 16px 0 0; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 24px;">Unifique Rastreador</h1>
            </td>
          </tr>
          <tr>
            <td style="background-color: white; padding: 40px 30px; border-radius: 0 0 16px 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
              <h2 style="color: #212492; margin: 0 0 20px 0; font-size: 20px;">Olá, ${nome || 'Usuário'}!</h2>

              <p style="color: #4a5568; line-height: 1.6; margin: 0 0 20px 0;">
                Recebemos uma solicitação para redefinir a senha da sua conta no Unifique Rastreador.
              </p>

              <p style="color: #4a5568; line-height: 1.6; margin: 0 0 30px 0;">
                Clique no botão abaixo para criar uma nova senha:
              </p>

              <div style="text-align: center; margin: 30px 0;">
                <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #3FCFD5 0%, #00A2FF 100%); color: white; text-decoration: none; padding: 16px 40px; border-radius: 12px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 15px rgba(63, 207, 213, 0.3);">
                  Redefinir Senha
                </a>
              </div>

              <p style="color: #718096; font-size: 14px; line-height: 1.6; margin: 0 0 10px 0;">
                Se o botão não funcionar, copie e cole o link abaixo no seu navegador:
              </p>

              <p style="color: #3FCFD5; font-size: 12px; word-break: break-all; background-color: #f7fafc; padding: 12px; border-radius: 8px; margin: 0 0 20px 0;">
                ${resetUrl}
              </p>

              <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 30px 0;">

              <p style="color: #a0aec0; font-size: 13px; margin: 0;">
                ⚠️ Este link expira em <strong>1 hora</strong>.
              </p>

              <p style="color: #a0aec0; font-size: 13px; margin: 10px 0 0 0;">
                Se você não solicitou a redefinição de senha, ignore este email. Sua senha permanecerá a mesma.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px; text-align: center;">
              <p style="color: #a0aec0; font-size: 12px; margin: 0;">
                © ${new Date().getFullYear()} Unifique Rastreador. Todos os direitos reservados.
              </p>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    const text = `
Olá, ${nome || 'Usuário'}!

Recebemos uma solicitação para redefinir a senha da sua conta no Unifique Rastreador.

Para criar uma nova senha, acesse o link abaixo:
${resetUrl}

⚠️ Este link expira em 1 hora.

Se você não solicitou a redefinição de senha, ignore este email.

---
Unifique Rastreador
    `;

    // Log do link para ambiente de desenvolvimento
    if (!this.isConfigured) {
      console.log('🔗 Link de recuperação de senha:');
      console.log(resetUrl);
    }

    return this.send(email, subject, html, text);
  }
}

module.exports = new EmailService();
