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
    // Inferir tipo de veículo baseado na marca/modelo
    const tipo = this.inferirTipoVeiculo(dados.marca, dados.modelo);

    return {
      placa: dados.placa,
      marca: dados.marca || null,
      modelo: dados.modelo || null,
      ano: dados.ano ? parseInt(dados.ano) : null,
      anoFabricacao: dados.anoFabricacao ? parseInt(dados.anoFabricacao) : null,
      cor: dados.cor || null,
      tipo: tipo, // ✅ NOVO: Tipo de veículo inferido
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
   * ✅ NOVO: Infere o tipo de veículo baseado na marca/modelo
   */
  inferirTipoVeiculo(marca, modelo) {
    if (!marca && !modelo) return null;

    const texto = `${marca || ''} ${modelo || ''}`.toUpperCase();

    // Motos
    const marcasMoto = ['HONDA', 'YAMAHA', 'SUZUKI', 'KAWASAKI', 'HARLEY', 'BMW MOTORRAD', 'DAFRA', 'SHINERAY', 'HAOJUE'];
    const modelosMoto = ['CG', 'BIZ', 'POP', 'TITAN', 'FAN', 'XRE', 'CB', 'NXR', 'BROS', 'YBR', 'FAZER', 'XTZ', 'LANDER', 'CROSSER', 'MT-', 'MT03', 'MT07', 'MT09', 'NINJA', 'Z400', 'Z900', 'BURGMAN', 'VESPA', 'PCX', 'SH', 'LEAD', 'ADV', 'SCOOTER'];

    for (const m of marcasMoto) {
      if (texto.includes(m)) return 'MOTOCICLETA';
    }
    for (const m of modelosMoto) {
      if (texto.includes(m)) return 'MOTOCICLETA';
    }

    // Caminhões
    const marcasCaminhao = ['SCANIA', 'VOLVO TRUCK', 'DAF', 'MAN', 'IVECO'];
    const modelosCaminhao = ['CARGO', 'CONSTELLATION', 'ACCELO', 'ATEGO', 'AXOR', 'ACTROS', 'DELIVERY', 'WORKER', 'TITAN', 'FH', 'FM', 'VM', 'NH', 'STRALIS', 'TECTOR', 'DAILY CHASSI', '1016', '1116', '1316', '1516', '1716', '1719', '1723', '1729', '1933', '2429', '2533', '2536', '3033', '1319', '1419', '1519', '1619', '1719', '1819', '1919', '2019', '2419', '2429', '2629', '2635', '3030', '4030', '4430'];

    for (const m of marcasCaminhao) {
      if (texto.includes(m)) return 'CAMINHAO';
    }
    for (const m of modelosCaminhao) {
      if (texto.includes(m)) return 'CAMINHAO';
    }

    // Ônibus
    const modelosOnibus = ['ONIBUS', 'ÔNIBUS', 'BUS', 'COMIL', 'MARCOPOLO', 'BUSSCAR', 'CAIO', 'NEOBUS', 'MASCARELLO', 'VOLARE', 'AGRALE MA', 'MICRO ONIBUS', 'MICROONIBUS', 'SENIOR', 'URBANO'];
    for (const m of modelosOnibus) {
      if (texto.includes(m)) return 'ONIBUS';
    }

    // Vans
    const modelosVan = ['SPRINTER', 'DUCATO', 'MASTER', 'BOXER', 'TRANSIT', 'DAILY', 'JUMPER', 'IVECO DAILY', 'H100', 'H350', 'HR', 'BONGO', 'TOPIC', 'SPACE VAN', 'FURGAO'];
    for (const m of modelosVan) {
      if (texto.includes(m)) return 'VAN';
    }

    // Utilitários (Pickups e SUVs grandes)
    const modelosUtilitario = ['HILUX', 'S10', 'RANGER', 'AMAROK', 'FRONTIER', 'L200', 'TRITON', 'SAVEIRO', 'STRADA', 'MONTANA', 'TORO', 'OROCH', 'MAVERICK', 'F-250', 'F250', 'SILVERADO', 'RAM', 'TITAN PICKUP'];
    for (const m of modelosUtilitario) {
      if (texto.includes(m)) return 'UTILITARIO';
    }

    // Se não identificou, provavelmente é carro
    return 'AUTOMOVEL';
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
