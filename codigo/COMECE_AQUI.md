# 🎯 COMECE AQUI - Teste Seu Projeto em 3 Minutos

> Você quer saber se o IMEI está funcionando e se dados estão chegando corretamente?
> **Siga este guia e terá a resposta em 3 minutos.**

---

## ⚡ Teste Rápido (60 segundos)

### Terminal 1: Iniciar Servidor
```bash
npm start
```

Aguarde ver:
```
🚗 Servidor TCP (Rastreador) escutando em 0.0.0.0:8877
✅ Servidor HTTP/WebSocket rodando
📱 Acesse em: http://localhost:62000    ← AQUI É SUA PORTA!
```

### Terminal 2: Validar Tudo Automaticamente
```bash
./validar-imei.sh
```

Esse script:
- ✅ Descobre seu IMEI automaticamente
- ✅ Valida se está conectado
- ✅ Verifica se heartbeat está chegando
- ✅ Verifica se localizações estão chegando
- ✅ Valida banco de dados
- ✅ Mostra relatório visual

**Pronto! Você terá a resposta se tudo está funcionando!**

---

## 🎁 O Que Você Vai Ver

### Se Funcionar ✅
```
═══════════════════════════════════════════════════════
RESULTADO DA VALIDAÇÃO
═══════════════════════════════════════════════════════

Testes passados: 6
Testes falhados: 0

✓ IMEI VALIDADO COM SUCESSO!

O IMEI 358758091234567 está:
  ✅ Com formato correto
  ✅ Conectado ao servidor
  ✅ Enviando heartbeat
  ✅ Enviando localizações
```

### Se Não Funcionar ❌
```
✗ IMEI COM PROBLEMAS

Problemas encontrados:
  - Dispositivo não está conectado

Soluções:
  1. Verifique o IMEI no dispositivo físico
  2. Certifique-se que XT40 está conectado na porta 8877
  3. Verifique se npm start está rodando
```

---

## 📚 Se Quiser Aprender Mais

| Você Quer... | Leia Isto |
|-------------|-----------|
| Entender tudo | `RESUMO_GPS_SOLUCAO.md` |
| Testar manualmente | `COMO_TESTAR_SEU_PROJETO.md` |
| Validar IMEI em detalhes | `VALIDAR_IMEI.md` |
| Troubleshooting | `GPS_TROUBLESHOOTING.md` |
| Entender o código | `MUDANCAS_CODIGO.md` |
| Referência rápida | `GPS_CHEAT_SHEET.txt` |

---

## 🎯 Suas Portas (NÃO ESQUEÇA!)

- **HTTP/API**: `62000` (não 8000!)
- **TCP Rastreador**: `8877` ✅

Todas as URLs usam `http://localhost:62000`

---

## 🔍 O Que Você Vai Saber

### Depois de rodar `./validar-imei.sh`:

✅ **IMEI Está Correto?**
- 15 dígitos
- Apenas números
- Registrado no banco

✅ **Rastreador Está Conectado?**
- Conectado na porta 8877
- Enviando heartbeat
- Status online/offline

✅ **Dados Estão Chegando?**
- Latitude e Longitude corretos
- Velocidade
- Timestamp com hora certa
- Salvos no banco de dados

✅ **Tudo Está Funcionando?**
- GPS ativado
- OBD2 ativado
- Intervalo correto
- Dados em tempo real

---

## 💡 Próximos Passos

1. ✅ Rodar o teste
2. ✅ Confirmar que funciona
3. ✅ Mudar UPLOAD_10S para UPLOAD_30S em produção
4. ✅ Configurar alertas
5. ✅ Visualizar no dashboard

---

## 🆘 Algo Deu Errado?

### Erro: "Nenhum dispositivo conectado"
→ XT40 não conectou. Verifique IP/Porta do rastreador.

### Erro: "Nenhuma localização"
→ GPS não foi ativado. Use: `./commands-gps.sh` e escolha opção 2.

### Erro: "Servidor não respondendo"
→ Certifique-se que rodou `npm start` no Terminal 1.

**Para mais ajuda**: Leia `GPS_TROUBLESHOOTING.md`

---

## ⏱️ Timeline

```
npm start          ← 1 segundo
./validar-imei.sh  ← 5 segundos
Resultado          ← Imediato
```

**Total: < 10 segundos para saber se tudo funciona!**

---

**Pronto? Vamos lá! 🚀**

```bash
# Terminal 1
npm start

# Terminal 2 (em outro terminal)
./validar-imei.sh
```

