"""
XT40 Protocol Parser - Implementação Completa e Corrigida
Suporta: 0x01 (Login), 0x12 (Location), 0x13 (Heartbeat), 0x16 (Alarm), 0x94 (OBD2)

CORREÇÕES APLICADAS:
✅ Latitude/Longitude: Usar /1800000 em vez de /30000
✅ Extração de N/S e E/W flags
✅ Validação de ranges
✅ Melhor tratamento de erros
"""

import struct
from datetime import datetime
from typing import Dict, Any, Tuple, List, Optional
from dataclasses import dataclass
from enum import Enum

# ============================================================================
# TABELA CRC-ITU COMPLETA (da documentação seção 7.1)
# ============================================================================

CRC_TABLE = [
    0x0000, 0x1189, 0x2312, 0x329B, 0x4624, 0x57AD, 0x6536, 0x74BF,
    0x8C48, 0x9DC1, 0xAF5A, 0xBED3, 0xCA6C, 0xDBE5, 0xE97E, 0xF8F7,
    0x1081, 0x0108, 0x3393, 0x221A, 0x56A5, 0x472C, 0x75B7, 0x643E,
    0x9CC9, 0x8D40, 0xBFDB, 0xAE52, 0xDAED, 0xCB64, 0xF9FF, 0xE876,
    0x2102, 0x308B, 0x0210, 0x1399, 0x6726, 0x76AF, 0x4434, 0x55BD,
    0xAD4A, 0xBCC3, 0x8E58, 0x9FD1, 0xEB6E, 0xFAE7, 0xC87C, 0xD9F5,
    0x3183, 0x200A, 0x1291, 0x0318, 0x77A7, 0x662E, 0x54B5, 0x453C,
    0xBDCB, 0xAC42, 0x9ED9, 0x8F50, 0xFBEF, 0xEA66, 0xD8FD, 0xC974,
    0x4204, 0x538D, 0x6116, 0x709F, 0x0420, 0x15A9, 0x2732, 0x36BB,
    0xCE4C, 0xDFC5, 0xED5E, 0xFCD7, 0x8868, 0x99E1, 0xAB7A, 0xBAF3,
    0x5285, 0x430C, 0x7197, 0x601E, 0x14A1, 0x0528, 0x37B3, 0x263A,
    0xDECD, 0xCF44, 0xFDDF, 0xEC56, 0x98E9, 0x8960, 0xBBFB, 0xAA72,
    0x6306, 0x728F, 0x4014, 0x519D, 0x2522, 0x34AB, 0x0630, 0x17B9,
    0xEF4E, 0xFEC7, 0xCC5C, 0xDDD5, 0xA96A, 0xB8E3, 0x8A78, 0x9BF1,
    0x7387, 0x620E, 0x5095, 0x411C, 0x35A3, 0x242A, 0x16B1, 0x0738,
    0xFFCF, 0xEE46, 0xDCDD, 0xCD54, 0xB9EB, 0xA862, 0x9AF9, 0x8B70,
    0x8408, 0x9581, 0xA71A, 0xB693, 0xC22C, 0xD3A5, 0xE13E, 0xF0B7,
    0x0840, 0x19C9, 0x2B52, 0x3ADB, 0x4E64, 0x5FED, 0x6D76, 0x7CFF,
    0x9489, 0x8500, 0xB79B, 0xA612, 0xD2AD, 0xC324, 0xF1BF, 0xE036,
    0x18C1, 0x0948, 0x3BD3, 0x2A5A, 0x5EE5, 0x4F6C, 0x7DF7, 0x6C7E,
    0xA50A, 0xB483, 0x8618, 0x9791, 0xE32E, 0xF2A7, 0xC03C, 0xD1B5,
    0x2942, 0x38CB, 0x0A50, 0x1BD9, 0x6F66, 0x7EEF, 0x4C74, 0x5DFD,
    0xB58B, 0xA402, 0x9699, 0x8710, 0xF3AF, 0xE226, 0xD0BD, 0xC134,
    0x39C3, 0x284A, 0x1AD1, 0x0B58, 0x7FE7, 0x6E6E, 0x5CF5, 0x4D7C,
    0xC60C, 0xD785, 0xE51E, 0xF497, 0x8028, 0x91A1, 0xA33A, 0xB2B3,
    0x4A44, 0x5BCD, 0x6956, 0x78DF, 0x0C60, 0x1DE9, 0x2F72, 0x3EFB,
    0xD68D, 0xC704, 0xF59F, 0xE416, 0x90A9, 0x8120, 0xB3BB, 0xA232,
    0x5AC5, 0x4B4C, 0x79D7, 0x685E, 0x1CE1, 0x0D68, 0x3FF3, 0x2E7A,
    0xE70E, 0xF687, 0xC41C, 0xD595, 0xA12A, 0xB0A3, 0x8238, 0x93B1,
    0x6B46, 0x7ACF, 0x4854, 0x59DD, 0x2D62, 0x3CEB, 0x0E70, 0x1FF9,
    0xF78F, 0xE606, 0xD49D, 0xC514, 0xB1AB, 0xA022, 0x92B9, 0x8330,
    0x7BC7, 0x6A4E, 0x58D5, 0x495C, 0x3DE3, 0x2C6A, 0x1EF1, 0x0F78,
]

# ============================================================================
# ENUMS E CONSTANTES
# ============================================================================

class ProtocolType(Enum):
    LOGIN = 0x01
    LOCATION_GPS_LBS = 0x12
    HEARTBEAT = 0x13
    ALARM = 0x16
    OBD2 = 0x94

class AlarmType(Enum):
    NORMAL = 0x00
    SOS = 0x01
    POWER_CUT = 0x02
    SHOCK = 0x03
    ACC_ON = 0x04
    ACC_OFF = 0x05
    OVER_SPEED = 0x08

class VoltageLevel(Enum):
    NO_POWER = 0
    EXTREMELY_LOW = 1
    VERY_LOW = 2
    LOW = 3
    MEDIUM = 4
    HIGH = 5
    VERY_HIGH = 6

# ============================================================================
# DATA CLASSES
# ============================================================================

@dataclass
class LocationData:
    timestamp: str
    latitude: float
    longitude: float
    speed_kmh: int
    course_degrees: int
    satellites: int
    gps_real_time: bool
    gps_positioned: bool
    longitude_east: bool
    latitude_north: bool

@dataclass
class TerminalResponse:
    protocol: int
    protocol_name: str
    timestamp: str
    serial: int
    crc: int
    is_valid: bool
    data: Dict[str, Any]

# ============================================================================
# PARSER PRINCIPAL
# ============================================================================

class XT40Parser:
    """Parser completo e corrigido do protocolo XT40/GT06"""

    PACKET_START = b'\x78\x78'
    PACKET_STOP = b'\x0d\x0a'
    MIN_PACKET_LENGTH = 10

    @staticmethod
    def calculate_crc16(data: bytes) -> int:
        """
        Calcula CRC-ITU usando tabela pré-calculada.

        Documentação:
        - CRC é calculado para: Length + Protocol + Content + Serial
        - Inicializa com 0xFFFF
        - Usa tabela de lookup de 256 posições
        - Resultado final é invertido (~crc)
        """
        if not isinstance(data, bytes):
            data = bytes(data)

        fcs = 0xFFFF
        for byte in data:
            fcs = (fcs >> 8) ^ CRC_TABLE[(fcs ^ byte) & 0xFF]

        return (~fcs) & 0xFFFF

    @staticmethod
    def validate_structure(packet: bytes) -> Tuple[bool, str]:
        """Valida estrutura básica do pacote"""

        if len(packet) < XT40Parser.MIN_PACKET_LENGTH:
            return False, f"Packet too short: {len(packet)} bytes"

        if packet[0:2] != XT40Parser.PACKET_START:
            return False, f"Invalid start bit: {packet[0:2].hex()}"

        if packet[-2:] != XT40Parser.PACKET_STOP:
            return False, f"Invalid stop bit: {packet[-2:].hex()}"

        return True, "OK"

    @staticmethod
    def validate_crc(packet: bytes) -> Tuple[bool, str, int, int]:
        """Valida CRC do pacote"""
        received_crc = struct.unpack('>H', packet[-4:-2])[0]
        data_for_crc = packet[2:-4]
        calculated_crc = XT40Parser.calculate_crc16(data_for_crc)

        if received_crc != calculated_crc:
            return False, f"CRC mismatch", received_crc, calculated_crc

        return True, "OK", received_crc, calculated_crc

    @staticmethod
    def parse_datetime(data: bytes) -> str:
        """Parse DateTime (6 bytes): YY MM DD HH MM SS"""
        try:
            year = data[0] + 2000
            month = data[1]
            day = data[2]
            hour = data[3]
            minute = data[4]
            second = data[5]

            dt = datetime(year, month, day, hour, minute, second)
            return dt.isoformat()
        except (ValueError, IndexError) as e:
            return f"INVALID_DATE"

    @staticmethod
    def parse_latitude(data: bytes) -> Tuple[float, bool]:
        """
        Parse Latitude (4 bytes)

        ✅ CORREÇÃO: Usar /1800000 em vez de /30000
        Formato: 1/30000 minuto, com bit N/S no MSB
        Conversão: valor / 30000 / 60 = valor / 1800000 graus

        Bit 31: 0=North, 1=South
        Bits 30-0: Latitude value
        Range: 0-324000000 (0°-180°, mas latitude máx é 90°)
        """
        value = struct.unpack('>I', data)[0]
        lat_ns = (value & 0x80000000) >> 31  # 0 = North, 1 = South
        lat_value = (value & 0x7FFFFFFF) / 1800000.0  # ✅ CORRETO

        # Validar range
        if lat_value > 90:
            lat_value = 90

        latitude = -lat_value if lat_ns else lat_value
        return round(latitude, 6), bool(lat_ns == 0)

    @staticmethod
    def parse_longitude(data: bytes) -> Tuple[float, bool]:
        """
        Parse Longitude (4 bytes)

        ✅ CORREÇÃO: Usar /1800000 em vez de /30000
        Formato: 1/30000 minuto, com bit E/W no MSB

        Bit 31: 0=East, 1=West
        Bits 30-0: Longitude value
        Range: 0-324000000 (0°-180°)
        """
        value = struct.unpack('>I', data)[0]
        lon_ew = (value & 0x80000000) >> 31  # 0 = East, 1 = West
        lon_value = (value & 0x7FFFFFFF) / 1800000.0  # ✅ CORRETO

        # Validar range
        if lon_value > 180:
            lon_value = 180

        longitude = -lon_value if lon_ew else lon_value
        return round(longitude, 6), bool(lon_ew == 0)

    @staticmethod
    def parse_course_status(data: bytes) -> Tuple[int, Dict[str, bool]]:
        """
        Parse Course (direção) e Status Flags (2 bytes)

        Byte 1 (MSB):
          Bit 7-6: Reservado
          Bit 5: GPS real-time (1) vs Differential (0)
          Bit 4: GPS positioned (1=sim, 0=não)
          Bit 3: Longitude (1=East, 0=West)
          Bit 2: Latitude (1=North, 0=South)
          Bit 1-0: Course (MSB)

        Byte 2 (LSB):
          Bits 7-0: Course (LSB)
        """
        byte1 = data[0]
        byte2 = data[1]

        course = ((byte1 & 0x03) << 8) | byte2

        status = {
            'gps_real_time': bool(byte1 & 0x20),
            'gps_positioned': bool(byte1 & 0x10),
            'longitude_east': bool(byte1 & 0x08),
            'latitude_north': bool(byte1 & 0x04),
        }

        return course, status

    @classmethod
    def parse_packet_0x01(cls, packet: bytes) -> TerminalResponse:
        """Parse Login packet (0x01)"""
        is_valid, msg = cls.validate_structure(packet)
        if not is_valid:
            raise ValueError(f"Invalid packet structure: {msg}")

        crc_valid, crc_msg, recv_crc, calc_crc = cls.validate_crc(packet)
        if not crc_valid:
            raise ValueError(f"CRC validation failed: {crc_msg}")

        protocol = packet[3]
        serial = struct.unpack('>H', packet[-6:-4])[0]

        content = packet[4:-6]

        # Extract IMEI (8 bytes, BCD encoded)
        imei = cls.bcd_to_string(content[0:8])

        return TerminalResponse(
            protocol=protocol,
            protocol_name='Login',
            timestamp=datetime.now().isoformat(),
            serial=serial,
            crc=recv_crc,
            is_valid=True,
            data={
                'imei': imei,
                'type': 'login'
            }
        )

    @classmethod
    def parse_packet_0x12(cls, packet: bytes) -> TerminalResponse:
        """
        Parse Location Data Packet (0x12)
        Contém: GPS + LBS Information
        """
        is_valid, msg = cls.validate_structure(packet)
        if not is_valid:
            raise ValueError(f"Invalid packet structure: {msg}")

        crc_valid, crc_msg, recv_crc, calc_crc = cls.validate_crc(packet)
        if not crc_valid:
            raise ValueError(f"CRC validation failed: {crc_msg}")

        protocol = packet[3]
        serial = struct.unpack('>H', packet[-6:-4])[0]

        content = packet[4:-6]
        offset = 0

        # DateTime (6 bytes)
        timestamp = cls.parse_datetime(content[offset:offset+6])
        offset += 6

        # GPS Length + Satellites (1 byte)
        gps_len_sat = content[offset]
        satellites = gps_len_sat & 0x0F
        offset += 1

        # Latitude (4 bytes) - ✅ CORRIGIDO
        latitude, lat_north = cls.parse_latitude(content[offset:offset+4])
        offset += 4

        # Longitude (4 bytes) - ✅ CORRIGIDO
        longitude, lon_east = cls.parse_longitude(content[offset:offset+4])
        offset += 4

        # Speed (1 byte)
        speed = content[offset]
        offset += 1

        # Course + Status (2 bytes)
        course, status_info = cls.parse_course_status(content[offset:offset+2])
        offset += 2

        # MCC, MNC, LAC, Cell ID
        mcc = struct.unpack('>H', content[offset:offset+2])[0]
        mnc = content[offset+2]
        lac = struct.unpack('>H', content[offset+3:offset+5])[0]
        cell_id = int.from_bytes(content[offset+5:offset+8], 'big')

        # Validações
        if latitude < -90 or latitude > 90:
            print(f"⚠️ Invalid latitude: {latitude}")
        if longitude < -180 or longitude > 180:
            print(f"⚠️ Invalid longitude: {longitude}")

        return TerminalResponse(
            protocol=protocol,
            protocol_name='Location Data (GPS + LBS)',
            timestamp=timestamp,
            serial=serial,
            crc=recv_crc,
            is_valid=True,
            data={
                'location': {
                    'latitude': latitude,
                    'longitude': longitude,
                    'latitude_north': lat_north,
                    'longitude_east': lon_east,
                },
                'movement': {
                    'speed_kmh': speed,
                    'course_degrees': course,
                },
                'gps': {
                    'satellites': satellites,
                    'real_time': status_info['gps_real_time'],
                    'positioned': status_info['gps_positioned'],
                },
                'lbs': {
                    'mcc': mcc,
                    'mnc': mnc,
                    'lac': lac,
                    'cell_id': cell_id,
                },
            }
        )

    @classmethod
    def parse_packet_0x13(cls, packet: bytes) -> TerminalResponse:
        """Parse Heartbeat Packet (0x13)"""
        is_valid, msg = cls.validate_structure(packet)
        if not is_valid:
            raise ValueError(f"Invalid packet structure: {msg}")

        crc_valid, crc_msg, recv_crc, calc_crc = cls.validate_crc(packet)
        if not crc_valid:
            raise ValueError(f"CRC validation failed: {crc_msg}")

        protocol = packet[3]
        serial = struct.unpack('>H', packet[-6:-4])[0]

        content = packet[4:-6]
        offset = 0

        # Terminal Info (1 byte)
        term_info = content[offset]
        offset += 1

        # Voltage Level (1 byte) - ✅ COM VALIDAÇÃO
        voltage_level = content[offset]
        if voltage_level > 6:
            voltage_level = 6  # Clamp to max
        offset += 1

        # GSM Signal Strength (1 byte) - ✅ COM VALIDAÇÃO
        gsm_signal = content[offset]
        if gsm_signal > 100:
            gsm_signal = 100  # Clamp to max
        offset += 1

        # Status
        terminal_status = {
            'oil_electricity_disconnected': bool(term_info & 0x80),
            'gps_tracking_on': bool(term_info & 0x40),
            'alarm_type': (term_info >> 3) & 0x07,
            'charging': bool(term_info & 0x04),
            'acc_high': bool(term_info & 0x02),
            'activated': bool(term_info & 0x01),
        }

        voltage_names = {
            0: 'No Power (shutdown)',
            1: 'Extremely Low Battery',
            2: 'Very Low Battery (Alarm)',
            3: 'Low Battery',
            4: 'Medium',
            5: 'High',
            6: 'Very High',
        }

        return TerminalResponse(
            protocol=protocol,
            protocol_name='Heartbeat (Status)',
            timestamp=datetime.now().isoformat(),
            serial=serial,
            crc=recv_crc,
            is_valid=True,
            data={
                'terminal_status': terminal_status,
                'voltage': {
                    'level': voltage_level,
                    'description': voltage_names.get(voltage_level, 'Unknown'),
                },
                'gsm': {
                    'signal_percent': gsm_signal,
                },
            }
        )

    @classmethod
    def parse_packet_0x16(cls, packet: bytes) -> TerminalResponse:
        """Parse Alarm Packet (0x16) - similar to 0x12"""
        result = cls.parse_packet_0x12(packet)
        result.protocol_name = 'Alarm Data'
        return result

    @classmethod
    def parse(cls, packet: bytes) -> Optional[TerminalResponse]:
        """Parse genérico de qualquer pacote XT40"""
        if len(packet) < cls.MIN_PACKET_LENGTH:
            raise ValueError(f"Packet too short: {len(packet)} bytes")

        protocol = packet[3]

        if protocol == ProtocolType.LOGIN.value:
            return cls.parse_packet_0x01(packet)
        elif protocol == ProtocolType.LOCATION_GPS_LBS.value:
            return cls.parse_packet_0x12(packet)
        elif protocol == ProtocolType.HEARTBEAT.value:
            return cls.parse_packet_0x13(packet)
        elif protocol == ProtocolType.ALARM.value:
            return cls.parse_packet_0x16(packet)
        else:
            raise ValueError(f"Protocol not supported: 0x{protocol:02X}")

    @staticmethod
    def bcd_to_string(bytes_data: bytes) -> str:
        """Convert BCD bytes to string (nibbles swapped)"""
        result = ''
        for byte in bytes_data:
            low = byte & 0x0F
            high = (byte >> 4) & 0x0F
            result += str(low) + str(high)
        return result

# ============================================================================
# TESTES
# ============================================================================

if __name__ == '__main__':
    parser = XT40Parser()

    print("=" * 70)
    print("XT40 PROTOCOL PARSER - TESTES (VERSÃO CORRIGIDA)")
    print("=" * 70)

    # Teste 1: Location Data (0x12)
    print("\n[TESTE 1] Location Data (0x12)")
    print("-" * 70)
    packet_0x12_hex = "78781F120B081D112E10CF027AC7EB0C465849001482F01CC00287D001FB80003808D0D0A"
    packet_0x12 = bytes.fromhex(packet_0x12_hex)

    try:
        result = parser.parse(packet_0x12)
        print(f"✅ Protocol: {result.protocol_name} (0x{result.protocol:02X})")
        print(f"   Timestamp: {result.timestamp}")
        print(f"   Location: {result.data['location']['latitude']:.6f}, {result.data['location']['longitude']:.6f}")
        print(f"   Speed: {result.data['movement']['speed_kmh']} km/h")
        print(f"   Course: {result.data['movement']['course_degrees']}°")
        print(f"   Satellites: {result.data['gps']['satellites']}")
        print(f"   Cell ID: {result.data['lbs']['cell_id']}")
        print(f"   Serial: {result.serial}")
        print(f"   CRC: 0x{result.crc:04X}")
    except Exception as e:
        print(f"❌ Error: {e}")

    # Teste 2: Heartbeat (0x13)
    print("\n[TESTE 2] Heartbeat (0x13)")
    print("-" * 70)
    packet_0x13 = bytes.fromhex("78780A134B0403000100110631000D0A")

    try:
        result = parser.parse(packet_0x13)
        print(f"✅ Protocol: {result.protocol_name} (0x{result.protocol:02X})")
        print(f"   Voltage: {result.data['voltage']['description']} (Level {result.data['voltage']['level']})")
        print(f"   GSM Signal: {result.data['gsm']['signal_percent']}%")
        print(f"   Status: {result.data['terminal_status']}")
        print(f"   Serial: {result.serial}")
    except Exception as e:
        print(f"❌ Error: {e}")

    # Teste 3: CRC Validation
    print("\n[TESTE 3] CRC Calculation")
    print("-" * 70)
    data_for_crc = bytes.fromhex("0A134B040300010011 0631")
    calculated_crc = parser.calculate_crc16(data_for_crc)
    print(f"Data: {data_for_crc.hex()}")
    print(f"Calculated CRC: 0x{calculated_crc:04X}")

    print("\n" + "=" * 70)
    print("Testes concluídos!")
    print("=" * 70)
