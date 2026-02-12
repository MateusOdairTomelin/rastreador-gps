/**
 * Sistema de Notificações Toast e Confirmação
 * Substitui alert() e confirm() nativos por versões modernas
 */

// Adicionar CSS dinamicamente
(function() {
  if (document.getElementById('toast-styles')) return;

  const style = document.createElement('style');
  style.id = 'toast-styles';
  style.textContent = `
    .toast-container {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 99999;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
    }

    .toast {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 20px;
      border-radius: 12px;
      background: rgba(20, 25, 60, 0.95);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(63, 207, 213, 0.3);
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4), 0 0 20px rgba(63, 207, 213, 0.1);
      color: #E8FCFD;
      font-size: 14px;
      min-width: 300px;
      max-width: 450px;
      pointer-events: auto;
      animation: toastSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      transform-origin: top right;
      position: relative;
      overflow: hidden;
    }

    .toast.toast-out {
      animation: toastSlideOut 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }

    @keyframes toastSlideIn {
      from { opacity: 0; transform: translateX(100px) scale(0.8); }
      to { opacity: 1; transform: translateX(0) scale(1); }
    }

    @keyframes toastSlideOut {
      from { opacity: 1; transform: translateX(0) scale(1); }
      to { opacity: 0; transform: translateX(100px) scale(0.8); }
    }

    .toast-icon {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      flex-shrink: 0;
    }

    .toast-success .toast-icon { background: linear-gradient(135deg, #10B981, #059669); }
    .toast-error .toast-icon { background: linear-gradient(135deg, #EF4444, #DC2626); }
    .toast-warning .toast-icon { background: linear-gradient(135deg, #F59E0B, #D97706); }
    .toast-info .toast-icon { background: linear-gradient(135deg, #3FCFD5, #00A2FF); }

    .toast-content { flex: 1; }
    .toast-title { font-weight: 600; margin-bottom: 2px; }
    .toast-message { opacity: 0.9; font-size: 13px; }

    .toast-close {
      background: none;
      border: none;
      color: rgba(255,255,255,0.5);
      cursor: pointer;
      padding: 4px;
      font-size: 18px;
      line-height: 1;
      transition: color 0.2s;
    }
    .toast-close:hover { color: white; }

    .toast-progress {
      position: absolute;
      bottom: 0;
      left: 0;
      height: 3px;
      border-radius: 0 0 12px 12px;
      animation: toastProgress 4s linear forwards;
    }

    .toast-success .toast-progress { background: linear-gradient(90deg, #10B981, #059669); }
    .toast-error .toast-progress { background: linear-gradient(90deg, #EF4444, #DC2626); }
    .toast-warning .toast-progress { background: linear-gradient(90deg, #F59E0B, #D97706); }
    .toast-info .toast-progress { background: linear-gradient(90deg, #3FCFD5, #00A2FF); }

    @keyframes toastProgress {
      from { width: 100%; }
      to { width: 0%; }
    }

    .confirm-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
      z-index: 99998;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: confirmFadeIn 0.2s ease;
    }

    @keyframes confirmFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .confirm-modal {
      background: linear-gradient(180deg, rgba(30, 35, 80, 0.98) 0%, rgba(20, 25, 60, 0.98) 100%);
      border: 1px solid rgba(63, 207, 213, 0.3);
      border-radius: 16px;
      padding: 28px;
      min-width: 380px;
      max-width: 450px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5), 0 0 40px rgba(63, 207, 213, 0.1);
      animation: confirmSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes confirmSlideIn {
      from { opacity: 0; transform: scale(0.9) translateY(-20px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }

    .confirm-icon {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      margin: 0 auto 20px;
    }

    .confirm-icon.warning { background: linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(217, 119, 6, 0.2)); border: 2px solid #F59E0B; }
    .confirm-icon.danger { background: linear-gradient(135deg, rgba(239, 68, 68, 0.2), rgba(220, 38, 38, 0.2)); border: 2px solid #EF4444; }
    .confirm-icon.info { background: linear-gradient(135deg, rgba(63, 207, 213, 0.2), rgba(0, 162, 255, 0.2)); border: 2px solid #3FCFD5; }

    .confirm-title {
      text-align: center;
      font-size: 18px;
      font-weight: 600;
      color: #E8FCFD;
      margin-bottom: 12px;
    }

    .confirm-message {
      text-align: center;
      color: rgba(232, 252, 253, 0.8);
      font-size: 14px;
      line-height: 1.5;
      margin-bottom: 24px;
    }

    .confirm-buttons {
      display: flex;
      gap: 12px;
      justify-content: center;
    }

    .confirm-btn {
      padding: 12px 24px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      border: none;
      min-width: 100px;
    }

    .confirm-btn-cancel {
      background: rgba(255, 255, 255, 0.1);
      color: #E8FCFD;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .confirm-btn-cancel:hover { background: rgba(255, 255, 255, 0.15); }

    .confirm-btn-confirm {
      background: linear-gradient(135deg, #3FCFD5, #00A2FF);
      color: white;
      box-shadow: 0 4px 15px rgba(63, 207, 213, 0.3);
    }
    .confirm-btn-confirm:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(63, 207, 213, 0.4);
    }

    .confirm-btn-danger {
      background: linear-gradient(135deg, #EF4444, #DC2626);
      color: white;
      box-shadow: 0 4px 15px rgba(239, 68, 68, 0.3);
    }
    .confirm-btn-danger:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(239, 68, 68, 0.4);
    }
  `;
  document.head.appendChild(style);

  // Criar container de toasts
  if (!document.querySelector('.toast-container')) {
    const container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
})();

/**
 * Exibe uma notificação toast moderna
 */
function showToast(message, type = 'info', title = null, duration = 4000) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  const titles = { success: 'Sucesso', error: 'Erro', warning: 'Atenção', info: 'Informação' };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || icons.info}</div>
    <div class="toast-content">
      <div class="toast-title">${title || titles[type] || titles.info}</div>
      <div class="toast-message">${message}</div>
    </div>
    <button class="toast-close" onclick="this.parentElement.remove()">×</button>
    <div class="toast-progress"></div>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);

  return toast;
}

// Atalhos
function toastSuccess(message, title) { return showToast(message, 'success', title); }
function toastError(message, title) { return showToast(message, 'error', title || 'Erro', 6000); }
function toastWarning(message, title) { return showToast(message, 'warning', title); }
function toastInfo(message, title) { return showToast(message, 'info', title); }

/**
 * Exibe um modal de confirmação moderno
 */
function showConfirm(message, options = {}) {
  return new Promise((resolve) => {
    const {
      title = 'Confirmar ação',
      type = 'warning',
      confirmText = 'Confirmar',
      cancelText = 'Cancelar',
      icon = null
    } = options;

    const icons = { warning: '⚠️', danger: '🗑️', info: '❓' };

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-modal">
        <div class="confirm-icon ${type}">${icon || icons[type] || icons.warning}</div>
        <div class="confirm-title">${title}</div>
        <div class="confirm-message">${message}</div>
        <div class="confirm-buttons">
          <button class="confirm-btn confirm-btn-cancel">${cancelText}</button>
          <button class="confirm-btn ${type === 'danger' ? 'confirm-btn-danger' : 'confirm-btn-confirm'}">${confirmText}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const cancelBtn = overlay.querySelector('.confirm-btn-cancel');
    const confirmBtn = overlay.querySelector('.confirm-btn-confirm, .confirm-btn-danger');

    const close = (result) => {
      overlay.style.animation = 'confirmFadeIn 0.2s ease reverse';
      setTimeout(() => {
        overlay.remove();
        resolve(result);
      }, 200);
    };

    cancelBtn.onclick = () => close(false);
    confirmBtn.onclick = () => close(true);
    overlay.onclick = (e) => { if (e.target === overlay) close(false); };
    cancelBtn.focus();
  });
}

// Atalhos para confirmações
async function confirmDelete(itemName) {
  return showConfirm(`Tem certeza que deseja excluir ${itemName}?`, {
    title: 'Confirmar exclusão',
    type: 'danger',
    confirmText: 'Excluir',
    icon: '🗑️'
  });
}

async function confirmAction(message, title = 'Confirmar') {
  return showConfirm(message, { title, type: 'warning' });
}
