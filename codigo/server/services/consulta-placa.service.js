/**
 * Serviço de Consulta de Placa de Veículos
 * Usando API Unifique PuxaPlaca
 */

const https = require('https');

class ConsultaPlacaService {
  constructor() {
    // Token da API Unifique PuxaPlaca
    this.apiToken = process.env.PUXAPLACA_TOKEN || '61fe6cd0335f49a4a57a3dc7ca369b87';
    this.apiHost = process.env.PUXAPLACA_HOST || 'unifique.puxaplaca.app';

    // Cache simples para evitar consultas repetidas
    this.cache = new Map();
    this.cacheTTL = 24 * 60 * 60 * 1000; // 24 horas

    console.log('[ConsultaPlaca] ✅ API PuxaPlaca configurada');
  }

  /**
   * Consulta dados do veículo pela placa
   * @param {string} placa - Placa do veículo (formato antigo ou Mercosul)
   * @returns {Promise<Object>} Dados do veículo
   */
  async consultarPlaca(placa) {
    // Normalizar placa (remover hífen, uppercase)
    const placaNormalizada = this.normalizarPlaca(placa);

    if (!this.validarPlaca(placaNormalizada)) {
      throw new Error('Placa inválida. Use formato ABC1234 ou ABC1D23');
    }

    // Verificar cache
    const cached = this.cache.get(placaNormalizada);
    if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
      console.log(`[ConsultaPlaca] Cache hit para ${placaNormalizada}`);
      return cached.data;
    }

    console.log(`[ConsultaPlaca] Consultando ${placaNormalizada} via PuxaPlaca`);

    try {
      const resultado = await this.consultarPuxaPlaca(placaNormalizada);

      // Salvar no cache
      if (resultado && !resultado.erro) {
        this.cache.set(placaNormalizada, {
          data: resultado,
          timestamp: Date.now()
        });
      }

      return resultado;
    } catch (error) {
      console.error('[ConsultaPlaca] Erro:', error.message);
      return null;
    }
  }

  /**
   * Consulta via API PuxaPlaca Unifique
   */
  async consultarPuxaPlaca(placa) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.apiHost,
        path: `/consulta/${placa}/${this.apiToken}`,
        method: 'GET',
        headers: {
          'User-Agent': 'RastreadorGPS/1.0',
          'Accept': 'application/json'
        },
        timeout: 15000
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log(`[ConsultaPlaca] PuxaPlaca status: ${res.statusCode}`);

          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);

              if (json.found && json.data) {
                const veiculo = json.data;
                resolve(this.formatarResultado({
                  placa: placa,
                  marca: veiculo.marca,
                  modelo: veiculo.modelo,
                  ano: veiculo.anoModelo || veiculo.ano,
                  anoFabricacao: veiculo.ano,
                  cor: veiculo.cor,
                  municipio: veiculo.municipio,
                  uf: veiculo.uf,
                  origem: veiculo.origem,
                  placaMercosul: veiculo.placa_modelo_novo,
                  placaAntiga: veiculo.placa_modelo_antigo,
                  fonte: 'PuxaPlaca'
                }));
              } else {
                console.log('[ConsultaPlaca] Veículo não encontrado');
                resolve(null);
              }
            } catch (e) {
              console.error('[ConsultaPlaca] Erro ao parsear resposta:', e.message);
              resolve(null);
            }
          } else {
            console.error(`[ConsultaPlaca] PuxaPlaca retornou ${res.statusCode}: ${data}`);
            resolve(null);
          }
        });
      });

      req.on('error', (e) => {
        console.error('[ConsultaPlaca] Erro na requisição:', e.message);
        resolve(null);
      });

      req.on('timeout', () => {
        req.destroy();
        console.error('[ConsultaPlaca] Timeout na requisição');
        resolve(null);
      });

      req.end();
    });
  }

  /**
   * Formata resultado para padrão único
   */
  formatarResultado(dados) {
    return {
      placa: dados.placa,
      marca: dados.marca || null,
      modelo: dados.modelo || null,
      ano: dados.ano ? parseInt(dados.ano) : null,
      anoFabricacao: dados.anoFabricacao ? parseInt(dados.anoFabricacao) : null,
      cor: dados.cor || null,
      municipio: dados.municipio || null,
      uf: dados.uf || null,
      origem: dados.origem || null,
      placaMercosul: dados.placaMercosul || null,
      placaAntiga: dados.placaAntiga || null,
      fonte: dados.fonte,
      consultadoEm: new Date().toISOString()
    };
  }

  /**
   * Normaliza placa para formato padrão (sem hífen, uppercase)
   */
  normalizarPlaca(placa) {
    return placa
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .trim();
  }

  /**
   * Valida formato da placa (antigo ou Mercosul)
   */
  validarPlaca(placa) {
    // Formato antigo: ABC1234
    const formatoAntigo = /^[A-Z]{3}[0-9]{4}$/;
    // Formato Mercosul: ABC1D23
    const formatoMercosul = /^[A-Z]{3}[0-9][A-Z][0-9]{2}$/;

    return formatoAntigo.test(placa) || formatoMercosul.test(placa);
  }

  /**
   * Verifica se o serviço está configurado
   */
  isConfigured() {
    return !!this.apiToken;
  }

  /**
   * Limpa cache antigo
   */
  limparCacheAntigo() {
    const agora = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if ((agora - value.timestamp) > this.cacheTTL) {
        this.cache.delete(key);
      }
    }
  }
}

module.exports = new ConsultaPlacaService();
