# Solicitacao de Documentacao - Protocolo 0x94 (OBD2 Data)

**Data:** 2025-12-11
**Produto:** X3Tech XT40-OBDII (CAT1)
**Firmware:** HA1617_XT40_OBDII_CAT1 V1.0.0 build 250120

---

## Assunto

Solicitacao de documentacao tecnica para o protocolo 0x94 (OBD2 Data) utilizado pelo rastreador XT40-OBDII.

---

## Contexto

Estamos desenvolvendo uma plataforma de rastreamento propria e precisamos interpretar corretamente os pacotes OBD2 (protocolo 0x94) enviados pelo dispositivo XT40-OBDII.

A documentacao oficial "XT40 Protocol rev1.06" (junho 2025) NAO inclui a especificacao do protocolo 0x94, apenas os protocolos:
- 0x01 (Login)
- 0x12/0x22 (Location)
- 0x13 (Heartbeat)
- 0x15 (String Info)
- 0x16 (Alarm)
- 0x1A (GPS Address)
- 0x80 (Online Command)

---

## Dados Capturados

### Pacotes 0x94 Reais (3 dispositivos diferentes)

**Dispositivo 1 - IMEI: 356354870658615**
```
79790020940A0356354870658615072429200012429389552920000001242933006DBEE40D0A
```

**Dispositivo 2 - IMEI: 356354870699551**
```
79790020940A0356354870699551072429200012179389552920000001217935003CC1730D0A
```

**Dispositivo 3 - IMEI: 356354870702322**
```
79790020940A035635487070232207242920001359678955292000000135967900D5E0430D0A
```

### Estrutura Observada

```
Offset  Bytes                   Interpretacao Atual
------  ----------------------  ----------------------------------
0-1     7979                    Start bits (header longo)
2-3     0020                    Length (32 bytes)
4       94                      Protocol Number (OBD2)
5       0A                      Sub-protocol? (valor = 10)
6-13    03563548706XXXXX        IMEI (8 bytes BCD)
14-29   ???                     DADOS OBD2 (16 bytes) - NAO DOCUMENTADO
30-31   XXXX                    Serial Number
32-33   XXXX                    CRC-ITU
34-35   0D0A                    Stop bits
```

### Bytes de Dados OBD2 (offset 14-29)

| Dispositivo | Bytes 14-29 (hex)                    |
|-------------|--------------------------------------|
| IMEI ...615 | 07 24 29 20 00 12 42 93 89 55 29 20 00 00 01 24 29 33 |
| IMEI ...551 | 07 24 29 20 00 12 17 93 89 55 29 20 00 00 01 21 79 35 |
| IMEI ...322 | 07 24 29 20 00 13 59 67 89 55 29 20 00 00 01 35 96 79 |

### Observacoes

1. Os bytes `07 24 29 20` sao IDENTICOS nos 3 dispositivos
   - Isso sugere que NAO sao dados dinamicos do veiculo (RPM/Temp/Fuel)
   - Podem ser timestamp ou configuracao

2. Os bytes finais diferem entre dispositivos:
   - `01 24 29 33` (device 1) = 12042931 decimal
   - `01 21 79 35` (device 2) = 12031029 decimal
   - `01 35 96 79` (device 3) = 20378521 decimal
   - Possivelmente odometro?

---

## Informacoes Necessarias

Por favor, forneca a documentacao do protocolo 0x94 com:

1. **Estrutura completa do pacote** - offset e tamanho de cada campo

2. **Campos de dados OBD2** - especificamente:
   - RPM do motor (offset, tamanho, formula de conversao)
   - Temperatura do motor (offset, tamanho, formula de conversao)
   - Nivel de combustivel (offset, tamanho, formula de conversao)
   - Velocidade (offset, tamanho, unidade)
   - Odometro (offset, tamanho, unidade)
   - Horimetro (offset, tamanho, unidade)

3. **Sub-protocolo** - O byte no offset 5 (valor 0x0A) indica alguma variante?

4. **Formulas de conversao** - Por exemplo:
   - Temperatura: `valor_raw - 40 = graus Celsius`?
   - RPM: `valor_raw * fator = RPM`?
   - Combustivel: `valor_raw = porcentagem`?

---

## Contato

[SEU NOME]
[SEU EMAIL]
[SEU TELEFONE]

---

## Anexos Sugeridos

Ao enviar este documento para X3Tech, inclua:
1. Numero de serie dos dispositivos
2. Nota fiscal de compra (se solicitado)
3. Screenshot dos dados recebidos no servidor

---

## Canais de Suporte X3Tech

- **Website:** https://www.x3tech.com.br
- **Email Suporte:** suporte@x3tech.com.br (verificar no site oficial)
- **WhatsApp:** (verificar no site oficial)

