/**
 * ✅ CORREÇÃO #3: TCP Packet Buffer
 * Gerencia a reassembly de pacotes fragmentados pelo TCP
 *
 * TCP pode fragmentar pacotes de múltiplas formas:
 * 1. Múltiplos pacotes em um frame
 * 2. 1 pacote distribuído em múltiplos frames
 *
 * Esta classe bufferiza dados brutos e extrai pacotes completos
 */

class TCPPacketBuffer {
  constructor(maxSize = 1024 * 10) {
    this.buffer = Buffer.alloc(0);
    this.packets = [];
    this.maxSize = maxSize;
    this.stats = {
      totalChunksReceived: 0,
      totalPacketsExtracted: 0,
      buffersCleared: 0,
    };
  }

  /**
   * Adiciona dados brutos recebidos do socket TCP
   */
  append(chunk) {
    if (!chunk || chunk.length === 0) {
      return;
    }

    this.stats.totalChunksReceived++;

    // Proteção contra buffer overflow
    if (this.buffer.length + chunk.length > this.maxSize) {
      console.warn(
        `[PacketBuffer] Buffer overflow protection: ` +
        `buffer ${this.buffer.length} + chunk ${chunk.length} > max ${this.maxSize}`
      );
      this.buffer = Buffer.alloc(0);
      this.stats.buffersCleared++;
    }

    // Concatenar dados novos
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Extrair pacotes completos
    this.extractCompletePackets();
  }

  /**
   * Procura por pacotes completos no buffer
   * Estrutura GT06: [0x7878/0x7979][length][...data...][crc][0x0D0A]
   */
  extractCompletePackets() {
    let offset = 0;

    while (offset < this.buffer.length) {
      // Procurar próximo header (0x7878 ou 0x7979)
      const headerIdx = this.findHeader(offset);

      if (headerIdx === -1) {
        // Nenhum header encontrado a partir de offset
        // Descartar dados antes de offset
        this.buffer = this.buffer.slice(offset);
        break;
      }

      // Se há dados antes do header, descartar (são lixo)
      if (headerIdx > offset) {
        const discarded = headerIdx - offset;
        console.warn(`[PacketBuffer] Discarded ${discarded} bytes before header`);
        offset = headerIdx;
      }

      // Tentar extrair um pacote completo a partir de offset
      const packet = this.tryExtractPacket(offset);

      if (!packet) {
        // Pacote incompleto - aguardar mais dados
        this.buffer = this.buffer.slice(offset);
        break;
      }

      // Pacote completo foi extraído!
      this.packets.push(packet.data);
      this.stats.totalPacketsExtracted++;

      // Continuar procurando a partir da posição do próximo pacote
      offset = packet.nextOffset;
    }

    // Remover dados processados
    this.buffer = this.buffer.slice(offset);
  }

  /**
   * Procura por header GT06 (0x7878 ou 0x7979) a partir de offset
   * Retorna índice do header ou -1
   */
  findHeader(offset = 0) {
    for (let i = offset; i < this.buffer.length - 1; i++) {
      const b1 = this.buffer[i];
      const b2 = this.buffer[i + 1];

      // Verificar se é header válido
      if ((b1 === 0x78 && b2 === 0x78) || (b1 === 0x79 && b2 === 0x79)) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Tenta extrair um pacote completo começando em offset
   * Se pacote está incompleto, retorna null
   * Se pacote é válido, retorna { data, nextOffset }
   */
  tryExtractPacket(offset) {
    // ✅ SUPORTE A DOIS FORMATOS:
    // 0x7878: header(2) + length(1 byte) + data(length) + footer(2) = 5 + length
    // 0x7979: header(2) + length(2 bytes) + data(length) + footer(2) = 6 + length

    // Precisamos pelo menos de: header(2) = 2 bytes para identificar o tipo
    if (offset + 2 > this.buffer.length) {
      return null;
    }

    // Ler header
    const header = this.buffer.readUInt16BE(offset);
    let length, lengthSize, totalSize;

    if (header === 0x7979) {
      // Formato 0x7979: length é 2 bytes
      if (offset + 4 > this.buffer.length) {
        return null; // Ainda não temos os 2 bytes de length
      }
      length = this.buffer.readUInt16BE(offset + 2);
      lengthSize = 2;
      totalSize = 2 + 2 + length + 2; // header(2) + length(2) + data(length) + footer(2)
    } else {
      // Formato 0x7878: length é 1 byte
      if (offset + 3 > this.buffer.length) {
        return null; // Ainda não temos o 1 byte de length
      }
      length = this.buffer.readUInt8(offset + 2);
      lengthSize = 1;
      totalSize = 2 + 1 + length + 2; // header(2) + length(1) + data(length) + footer(2)
    }

    // Verificar se temos dados suficientes
    if (offset + totalSize > this.buffer.length) {
      // Pacote ainda está incompleto
      return null;
    }

    // Verificar footer (0x0D0A)
    const footerPos = offset + totalSize - 2;
    const footer = this.buffer.readUInt16BE(footerPos);

    if (footer !== 0x0D0A) {
      console.warn(
        `[PacketBuffer] Invalid footer at offset ${footerPos} (format: 0x${header.toString(16).padStart(4, '0').toUpperCase()}): ` +
        `0x${footer.toString(16).padStart(4, '0').toUpperCase()} ` +
        `(expected 0x0D0A). Trying next position.`
      );

      // Tentar encontrar próximo pacote a partir da próxima posição
      return this.tryExtractPacket(offset + 1);
    }

    // Pacote válido!
    const packet = this.buffer.slice(offset, offset + totalSize);

    return {
      data: packet,
      nextOffset: offset + totalSize,
    };
  }

  /**
   * Retorna pacotes extraídos e limpa a lista
   */
  getPackets() {
    const result = this.packets;
    this.packets = [];
    return result;
  }

  /**
   * Retorna tamanho atual do buffer
   */
  getBufferSize() {
    return this.buffer.length;
  }

  /**
   * Retorna estatísticas (para debug)
   */
  getStats() {
    return {
      ...this.stats,
      currentBufferSize: this.buffer.length,
      pendingPackets: this.packets.length,
    };
  }

  /**
   * Limpa o buffer (usar em reset)
   */
  clear() {
    this.buffer = Buffer.alloc(0);
    this.packets = [];
  }

  /**
   * Reset de estatísticas
   */
  resetStats() {
    this.stats = {
      totalChunksReceived: 0,
      totalPacketsExtracted: 0,
      buffersCleared: 0,
    };
  }
}

module.exports = TCPPacketBuffer;
