const http = require('http');
const fs = require('fs');
const path = require('path');

const IMEI = '356354870702322';
const INTERVALO_COLETA = 5000; // 5 segundos
const ARQUIVO_DADOS = path.join(__dirname, `dados_xt40_${IMEI}_${new Date().toISOString().split('T')[0]}.json`);
const ARQUIVO_LOG = path.join(__dirname, `log_xt40_${IMEI}_${new Date().toISOString().split('T')[0]}.txt`);

let dadosColetados = [];
let ultimoDado = null;
let contadorColetas = 0;
let contadorNovos = 0;

function log(mensagem) {
    const timestamp = new Date().toISOString();
    const linha = `[${timestamp}] ${mensagem}`;
    console.log(linha);
    fs.appendFileSync(ARQUIVO_LOG, linha + '\n');
}

function salvarDados() {
    fs.writeFileSync(ARQUIVO_DADOS, JSON.stringify(dadosColetados, null, 2));
}

function coletarLocalizacao() {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:62000/api/dispositivos/${IMEI}/localizacao-atual`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

function coletarStatusDispositivo() {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:62000/api/dispositivos`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.sucesso && result.dados) {
                        const dispositivo = result.dados.find(d => d.imei === IMEI);
                        resolve(dispositivo);
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

function coletarHistorico() {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:62000/api/dispositivos/${IMEI}/historico?limite=50`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

async function executarColeta() {
    contadorColetas++;
    const timestampColeta = new Date().toISOString();

    try {
        const [localizacao, statusDispositivo, historico] = await Promise.all([
            coletarLocalizacao().catch(e => ({ erro: e.message })),
            coletarStatusDispositivo().catch(e => ({ erro: e.message })),
            coletarHistorico().catch(e => ({ erro: e.message }))
        ]);

        const registro = {
            timestampColeta,
            numeroColeta: contadorColetas,
            localizacao: localizacao?.dados || localizacao,
            statusDispositivo,
            historicoRecente: historico?.dados?.slice(0, 5) || []
        };

        // Verificar se é um dado novo
        const locAtual = localizacao?.dados;
        const ehNovo = !ultimoDado ||
            (locAtual && (
                locAtual.id !== ultimoDado.id ||
                locAtual.timestamp !== ultimoDado.timestamp ||
                locAtual.latitude !== ultimoDado.latitude ||
                locAtual.longitude !== ultimoDado.longitude
            ));

        if (ehNovo && locAtual) {
            contadorNovos++;
            registro.dadoNovo = true;
            log(`NOVO DADO #${contadorNovos}: ID=${locAtual.id}, Lat=${locAtual.latitude}, Lon=${locAtual.longitude}, Vel=${locAtual.velocidade}km/h, Dir=${locAtual.direcao}, Timestamp=${locAtual.timestamp}`);
            ultimoDado = locAtual;
        } else {
            registro.dadoNovo = false;
        }

        dadosColetados.push(registro);
        salvarDados();

        // Log resumido a cada 10 coletas
        if (contadorColetas % 10 === 0) {
            log(`STATUS: ${contadorColetas} coletas realizadas, ${contadorNovos} dados novos, ${dadosColetados.length} registros salvos`);
        }

    } catch (erro) {
        log(`ERRO na coleta: ${erro.message}`);
    }
}

// Iniciar coleta
log('='.repeat(60));
log(`INICIANDO COLETA DE DADOS - XT40 OBD`);
log(`IMEI: ${IMEI}`);
log(`Intervalo de coleta: ${INTERVALO_COLETA/1000} segundos`);
log(`Arquivo de dados: ${ARQUIVO_DADOS}`);
log(`Arquivo de log: ${ARQUIVO_LOG}`);
log('='.repeat(60));

// Executar primeira coleta imediatamente
executarColeta();

// Continuar coletando em intervalo regular
const intervalo = setInterval(executarColeta, INTERVALO_COLETA);

// Tratamento de encerramento
process.on('SIGINT', () => {
    log('');
    log('='.repeat(60));
    log('ENCERRANDO COLETA...');
    log(`Total de coletas: ${contadorColetas}`);
    log(`Dados novos coletados: ${contadorNovos}`);
    log(`Registros salvos: ${dadosColetados.length}`);
    log(`Arquivo de dados: ${ARQUIVO_DADOS}`);
    log('='.repeat(60));
    clearInterval(intervalo);
    salvarDados();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('SIGTERM recebido, encerrando...');
    clearInterval(intervalo);
    salvarDados();
    process.exit(0);
});

console.log('\nColeta iniciada! Pressione Ctrl+C para encerrar.\n');
