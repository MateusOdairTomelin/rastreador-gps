const prisma = require('../db/prisma');

class AlarmeService {
  // Get alarms for device
  async getByDevice(imei, limit = 50) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
    });

    if (!dispositivo) {
      throw new Error('Dispositivo não encontrado');
    }

    return await prisma.alarme.findMany({
      where: { dispositivo_id: dispositivo.id },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }

  // Get unresolved alarms
  async getUnresolved(imei) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
    });

    if (!dispositivo) {
      throw new Error('Dispositivo não encontrado');
    }

    return await prisma.alarme.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        resolvido: false,
      },
      orderBy: { timestamp: 'desc' },
    });
  }

  // Create alarm
  async create(imei, alarmeData) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
    });

    if (!dispositivo) {
      throw new Error('Dispositivo não encontrado');
    }

    // ✅ PROTOCOLO XT40 REV 1.06: Aceitar todos os campos do pacote 0x16
    const validFields = {
      tipo_alarme: alarmeData.tipo_alarme || 'Unknown',
      descricao: alarmeData.descricao || null,
      severidade: alarmeData.severidade || 'info',
      resolvido: alarmeData.resolvido || false,
      timestamp: alarmeData.timestamp || new Date(),
    };

    console.log(`[Alarm] ✅ 0x16 ALARM PACKET RECEIVED`);
    console.log(`  ├─ Type: ${validFields.tipo_alarme}`);
    console.log(`  ├─ Severity: ${validFields.severidade}`);
    console.log(`  ├─ Location: ${alarmeData.latitude?.toFixed(6)}, ${alarmeData.longitude?.toFixed(6)}`);
    console.log(`  ├─ Speed: ${alarmeData.velocidade} km/h`);
    console.log(`  ├─ GPS Satellites: ${alarmeData.satelites}`);
    console.log(`  ├─ Voltage Level: ${alarmeData.nivel_tensao}`);
    console.log(`  └─ GSM Signal: ${alarmeData.sinal_gsm}%`);

    return await prisma.alarme.create({
      data: {
        dispositivo_id: dispositivo.id,
        ...validFields,
      },
    });
  }

  // Resolve alarm
  async resolve(id) {
    return await prisma.alarme.update({
      where: { id },
      data: { resolvido: true },
    });
  }
}

module.exports = new AlarmeService();
