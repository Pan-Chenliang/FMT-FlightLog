const MAVLINK_V1_MAGIC = 0xfe;
const MAVLINK_V2_MAGIC = 0xfd;
const FILE_TRANSFER_PROTOCOL_ID = 110;
const FILE_TRANSFER_PROTOCOL_CRC_EXTRA = 84;
const FTP_PAYLOAD_SIZE = 251;

const FTP_OPCODE = {
  LIST_DIRECTORY: 3,
  ACK: 128,
  NAK: 129,
};

const FTP_ERROR = {
  1: "Fail",
  2: "FailErrno",
  3: "InvalidDataSize",
  4: "InvalidSession",
  5: "NoSessionsAvailable",
  6: "EndOfFile",
  7: "UnknownCommand",
  8: "FileExists",
  9: "FileProtected",
  10: "FileNotFound",
};

function x25CrcAccumulate(byte, crc) {
  let tmp = byte ^ (crc & 0xff);
  tmp ^= (tmp << 4) & 0xff;
  return (((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff);
}

function x25Crc(bytes, extra) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc = x25CrcAccumulate(byte, crc);
  }
  return x25CrcAccumulate(extra, crc);
}

function writeUint16LE(buffer, offset, value) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
}

function writeUint32LE(buffer, offset, value) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = (value >> 16) & 0xff;
  buffer[offset + 3] = (value >> 24) & 0xff;
}

function readUint16LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8);
}

function readUint32LE(buffer, offset) {
  return (buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24)) >>> 0;
}

function parseDirectoryEntries(bytes) {
  const decoder = new TextDecoder();
  const entries = [];
  let start = 0;

  for (let index = 0; index <= bytes.length; index += 1) {
    if (index !== bytes.length && bytes[index] !== 0) {
      continue;
    }

    if (index > start) {
      const text = decoder.decode(bytes.slice(start, index));
      const type = text[0];
      const parts = text.slice(1).split("\t");
      entries.push({
        type,
        name: parts[0] ?? "",
        size: Number(parts[1] ?? 0),
        modifiedTime: parts[2] ? Number(parts[2]) : null,
      });
    }
    start = index + 1;
  }

  return entries.filter((entry) => entry.name && entry.type !== "S");
}

export class MavlinkFtpClient {
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this.readLoopPromise = null;
    this.rxBuffer = [];
    this.waiters = [];
    this.mavSeq = 0;
    this.ftpSeq = 0;
    this.sourceSystem = 255;
    this.sourceComponent = 190;
    this.targetNetwork = 0;
    this.targetSystem = 1;
    this.targetComponent = 1;
  }

  async open(baudRate) {
    if (!this.port.readable || !this.port.writable) {
      await this.port.open({ baudRate });
    }
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.readLoopPromise = this.readLoop();
  }

  async readLoop() {
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) {
          break;
        }
        if (value) {
          this.rxBuffer.push(...value);
          this.consumeFrames();
        }
      }
    } catch {
      // Reader cancellation and disconnects are surfaced through request timeouts.
    }
  }

  consumeFrames() {
    while (this.rxBuffer.length > 0) {
      const magicIndex = this.rxBuffer.findIndex((byte) => byte === MAVLINK_V1_MAGIC || byte === MAVLINK_V2_MAGIC);
      if (magicIndex < 0) {
        this.rxBuffer.length = 0;
        return;
      }
      if (magicIndex > 0) {
        this.rxBuffer.splice(0, magicIndex);
      }

      const magic = this.rxBuffer[0];
      const length = this.rxBuffer[1];
      const headerLength = magic === MAVLINK_V2_MAGIC ? 10 : 6;
      const signatureLength = magic === MAVLINK_V2_MAGIC && (this.rxBuffer[2] & 0x01) ? 13 : 0;
      const frameLength = headerLength + length + 2 + signatureLength;
      if (this.rxBuffer.length < frameLength) {
        return;
      }

      const frame = this.rxBuffer.splice(0, frameLength);
      const message = magic === MAVLINK_V2_MAGIC ? this.parseV2Frame(frame) : this.parseV1Frame(frame);
      if (message) {
        this.handleMessage(message);
      }
    }
  }

  parseV2Frame(frame) {
    const length = frame[1];
    const msgId = frame[7] | (frame[8] << 8) | (frame[9] << 16);
    const payload = frame.slice(10, 10 + length);
    return { msgId, payload };
  }

  parseV1Frame(frame) {
    const length = frame[1];
    const msgId = frame[5];
    const payload = frame.slice(6, 6 + length);
    return { msgId, payload };
  }

  handleMessage(message) {
    if (message.msgId !== FILE_TRANSFER_PROTOCOL_ID || message.payload.length < 15) {
      return;
    }

    const ftpPayload = message.payload.slice(3, 254);
    const ftpMessage = {
      sequence: readUint16LE(ftpPayload, 0),
      session: ftpPayload[2],
      opcode: ftpPayload[3],
      size: ftpPayload[4],
      requestOpcode: ftpPayload[5],
      burstComplete: ftpPayload[6],
      offset: readUint32LE(ftpPayload, 8),
      data: ftpPayload.slice(12, 12 + ftpPayload[4]),
    };

    const matching = this.waiters.filter((waiter) => waiter.matches(ftpMessage));
    for (const waiter of matching) {
      waiter.resolve(ftpMessage);
      clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter((item) => item !== waiter);
    }
  }

  buildFtpPayload({ sequence, opcode, size, offset, data }) {
    const payload = new Uint8Array(FTP_PAYLOAD_SIZE);
    writeUint16LE(payload, 0, sequence);
    payload[2] = 0;
    payload[3] = opcode;
    payload[4] = size;
    payload[5] = 0;
    payload[6] = 0;
    payload[7] = 0;
    writeUint32LE(payload, 8, offset);
    payload.set(data, 12);
    return payload;
  }

  buildMavlink2Frame(ftpPayload) {
    const payload = new Uint8Array(254);
    payload[0] = this.targetNetwork;
    payload[1] = this.targetSystem;
    payload[2] = this.targetComponent;
    payload.set(ftpPayload, 3);

    const frame = new Uint8Array(10 + payload.length + 2);
    frame[0] = MAVLINK_V2_MAGIC;
    frame[1] = payload.length;
    frame[2] = 0;
    frame[3] = 0;
    frame[4] = this.mavSeq;
    frame[5] = this.sourceSystem;
    frame[6] = this.sourceComponent;
    frame[7] = FILE_TRANSFER_PROTOCOL_ID & 0xff;
    frame[8] = (FILE_TRANSFER_PROTOCOL_ID >> 8) & 0xff;
    frame[9] = (FILE_TRANSFER_PROTOCOL_ID >> 16) & 0xff;
    frame.set(payload, 10);

    const crc = x25Crc(frame.slice(1, 10 + payload.length), FILE_TRANSFER_PROTOCOL_CRC_EXTRA);
    writeUint16LE(frame, 10 + payload.length, crc);
    this.mavSeq = (this.mavSeq + 1) & 0xff;
    return frame;
  }

  async sendFtpCommand(command) {
    const frame = this.buildMavlink2Frame(this.buildFtpPayload(command));
    await this.writer.write(frame);
  }

  waitForResponse(sequence, requestOpcode, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      const waiter = {
        matches: (message) => message.sequence === sequence && message.requestOpcode === requestOpcode,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          reject(new Error("等待 MAVLink FTP 响应超时"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async request(command, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const responsePromise = this.waitForResponse(command.sequence, command.opcode);
      await this.sendFtpCommand(command);
      try {
        return await responsePromise;
      } catch (error) {
        if (attempt === retries) {
          throw error;
        }
      }
    }
    throw new Error("MAVLink FTP 请求失败");
  }

  async listDirectory(path) {
    const encoder = new TextEncoder();
    const pathBytes = encoder.encode(path);
    const entries = [];
    let offset = 0;

    while (true) {
      const sequence = this.ftpSeq;
      this.ftpSeq = (this.ftpSeq + 1) & 0xffff;
      const response = await this.request({
        sequence,
        opcode: FTP_OPCODE.LIST_DIRECTORY,
        size: pathBytes.length,
        offset,
        data: pathBytes,
      });

      if (response.opcode === FTP_OPCODE.NAK) {
        const errorCode = response.data[0];
        if (errorCode === 6) {
          return entries;
        }
        throw new Error(`MAVLink FTP NAK: ${FTP_ERROR[errorCode] ?? errorCode}`);
      }

      if (response.opcode !== FTP_OPCODE.ACK) {
        throw new Error(`未知 MAVLink FTP 响应 opcode: ${response.opcode}`);
      }

      const pageEntries = parseDirectoryEntries(response.data);
      entries.push(...pageEntries);
      if (pageEntries.length === 0) {
        return entries;
      }
      offset += pageEntries.length;
    }
  }
}
