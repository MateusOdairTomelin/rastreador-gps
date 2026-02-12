/**
 * Módulo de Autenticação - Unifique Rastreador
 * Gerencia tokens JWT, refresh automático e proteção de rotas
 */

const Auth = {
  API_URL: '/api',

  /**
   * Obtém o token de acesso atual
   */
  getAccessToken() {
    return localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken');
  },

  /**
   * Obtém o refresh token
   */
  getRefreshToken() {
    return localStorage.getItem('refreshToken') || sessionStorage.getItem('refreshToken');
  },

  /**
   * Obtém dados do usuário logado
   */
  getUsuario() {
    const data = localStorage.getItem('usuario') || sessionStorage.getItem('usuario');
    return data ? JSON.parse(data) : null;
  },

  /**
   * Verifica se está autenticado
   */
  isAuthenticated() {
    const token = this.getAccessToken();
    if (!token) return false;

    // Verificar se token expirou (decode básico do JWT)
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      const exp = payload.exp * 1000; // converter para ms
      return Date.now() < exp;
    } catch {
      return false;
    }
  },

  /**
   * Salva os tokens no storage
   */
  saveTokens(accessToken, refreshToken, usuario, remember = true) {
    const storage = remember ? localStorage : sessionStorage;
    storage.setItem('accessToken', accessToken);
    storage.setItem('refreshToken', refreshToken);
    storage.setItem('usuario', JSON.stringify(usuario));

    // Manter em sessionStorage também para consistência
    sessionStorage.setItem('accessToken', accessToken);
    sessionStorage.setItem('refreshToken', refreshToken);
    sessionStorage.setItem('usuario', JSON.stringify(usuario));
  },

  /**
   * Limpa os tokens (logout)
   */
  clearTokens() {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('usuario');
    sessionStorage.removeItem('accessToken');
    sessionStorage.removeItem('refreshToken');
    sessionStorage.removeItem('usuario');
  },

  /**
   * Faz logout e redireciona para login
   */
  async logout() {
    const refreshToken = this.getRefreshToken();

    if (refreshToken) {
      try {
        await fetch(`${this.API_URL}/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken })
        });
      } catch (e) {
        console.error('Erro no logout:', e);
      }
    }

    this.clearTokens();
    window.location.href = '/login.html';
  },

  /**
   * Renova o access token usando o refresh token
   * Envia o token antigo no header para preservar organização
   */
  async refreshAccessToken() {
    const refreshToken = this.getRefreshToken();

    if (!refreshToken) {
      return false;
    }

    try {
      // Incluir token antigo (mesmo expirado) para preservar organização
      const oldToken = this.getAccessToken();
      const headers = { 'Content-Type': 'application/json' };
      if (oldToken) {
        headers['Authorization'] = `Bearer ${oldToken}`;
      }

      const response = await fetch(`${this.API_URL}/auth/refresh`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ refreshToken })
      });

      if (response.ok) {
        const data = await response.json();
        if (data.accessToken && data.refreshToken) {
          // Manter a preferência de storage do usuário
          const useLocalStorage = localStorage.getItem('accessToken') !== null;
          this.saveTokens(data.accessToken, data.refreshToken, this.getUsuario(), useLocalStorage);
          return true;
        }
      }
    } catch (e) {
      console.error('Erro ao renovar token:', e);
    }

    return false;
  },

  /**
   * Verifica autenticação e redireciona para login se necessário
   */
  async requireAuth() {
    if (!this.isAuthenticated()) {
      // Tentar renovar token
      const renewed = await this.refreshAccessToken();
      if (!renewed) {
        this.clearTokens();
        window.location.href = '/login.html';
        return false;
      }
    }
    return true;
  },

  /**
   * Retorna headers com autenticação
   */
  getAuthHeaders() {
    const token = this.getAccessToken();
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
  }
};

/**
 * Salva referência ao fetch original ANTES de qualquer modificação
 */
const originalFetch = window.fetch.bind(window);

/**
 * Fetch autenticado - usa o fetch original com token
 * Adiciona automaticamente o token e trata erros 401
 */
async function fetchAuth(url, options = {}) {
  // Adicionar token de autenticação
  const token = Auth.getAccessToken();

  if (!options.headers) {
    options.headers = {};
  }

  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }

  // Se não tiver Content-Type e tiver body, adicionar
  if (options.body && !options.headers['Content-Type']) {
    options.headers['Content-Type'] = 'application/json';
  }

  try {
    // IMPORTANTE: Usar originalFetch para evitar loop infinito
    let response = await originalFetch(url, options);

    // Se receber 401, tentar renovar token e refazer requisição
    if (response.status === 401) {
      const renewed = await Auth.refreshAccessToken();

      if (renewed) {
        // Atualizar token no header e refazer requisição
        options.headers['Authorization'] = `Bearer ${Auth.getAccessToken()}`;
        response = await originalFetch(url, options);
      } else {
        // Não conseguiu renovar, redirecionar para login
        Auth.clearTokens();
        window.location.href = '/login.html';
        throw new Error('Sessão expirada');
      }
    }

    return response;
  } catch (error) {
    // Se for erro de rede ou outro, propagar
    throw error;
  }
}

/**
 * Sobrescreve o fetch global para adicionar autenticação automaticamente
 * Isso permite que código existente continue funcionando
 */
window.fetch = async function(url, options = {}) {
  // Verificar se é uma chamada para a API
  const isApiCall = typeof url === 'string' && (url.startsWith('/api') || url.includes('/api/'));

  // Não interceptar chamadas para /api/auth/login ou /api/auth/registro-inicial
  const isAuthRoute = typeof url === 'string' && (
    url.includes('/auth/login') ||
    url.includes('/auth/registro-inicial') ||
    url.includes('/auth/refresh')
  );

  if (isApiCall && !isAuthRoute) {
    return fetchAuth(url, options);
  }

  // Para outras chamadas, usar fetch original
  return originalFetch.call(window, url, options);
};

/**
 * Adiciona informações do usuário no header da página (se existir elemento)
 */
function setupUserInfo() {
  const usuario = Auth.getUsuario();

  if (usuario) {
    // Procurar elemento para mostrar nome do usuário
    const userNameEl = document.getElementById('userName') || document.querySelector('.user-name');
    if (userNameEl) {
      userNameEl.textContent = usuario.nome;
    }

    // Procurar elemento para mostrar role
    const userRoleEl = document.getElementById('userRole') || document.querySelector('.user-role');
    if (userRoleEl) {
      userRoleEl.textContent = usuario.role === 'admin' ? 'Administrador' :
                               usuario.role === 'operador' ? 'Operador' : 'Visualizador';
    }

    // Procurar elemento para mostrar email
    const userEmailEl = document.getElementById('userEmail') || document.querySelector('.user-email');
    if (userEmailEl) {
      userEmailEl.textContent = usuario.email;
    }
  }

  // Adicionar handler para botão de logout
  const logoutBtns = document.querySelectorAll('.btn-logout, #btnLogout, [data-logout]');
  logoutBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      Auth.logout();
    });
  });
}

/**
 * Inicialização automática ao carregar a página
 */
document.addEventListener('DOMContentLoaded', async () => {
  // Verificar se é página de login
  const isLoginPage = window.location.pathname.includes('login.html');

  if (!isLoginPage) {
    // Verificar autenticação
    const isAuth = await Auth.requireAuth();

    if (isAuth) {
      setupUserInfo();
    }
  }
});

// Exportar para uso global
window.Auth = Auth;
window.fetchAuth = fetchAuth;
