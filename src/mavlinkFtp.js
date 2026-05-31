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
    // Start FTP sequence at 100 to avoid low-number collisions during testing
    this.ftpSeq = 100;
    this.sourceSystem = 255;
    this.sourceComponent = 190;
    this.targetNetwork = 0;
    this.targetSystem = 1;
    this.targetComponent = 1;
    this._gotHeartbeat = false;
    this._heartbeatWaiters = [];
    // Which msgIds should be logged. Keep FTP by default; HEARTBEAT is logged once on first receipt.
    this.logMsgIds = new Set([FILE_TRANSFER_PROTOCOL_ID]);
    // Verbose general logs (reads, lifecycle). Keep false to minimize noise.
    this.verbose = false;
  }

  async close() {
    try {
      // Stop reader
      if (this.reader) {
        try {
          await this.reader.cancel();
        } catch (e) {
          console.warn("MavlinkFtpClient: reader.cancel failed", e);
        }
        try {
          this.reader.releaseLock();
        } catch (e) {
          // ignore
        }
        this.reader = null;
      }

      // Close writer
      if (this.writer) {
        try {
          if (typeof this.writer.close === "function") {
            await this.writer.close();
          }
        } catch (e) {
          console.warn("MavlinkFtpClient: writer.close failed", e);
        }
        try {
          this.writer.releaseLock();
        } catch (e) {
          // ignore
        }
        this.writer = null;
      }

      // Close underlying port if possible
      if (this.port && typeof this.port.close === "function") {
        try {
          await this.port.close();
        } catch (e) {
          console.warn("MavlinkFtpClient: port.close failed", e);
        }
      }

      // Clear pending waiters
      for (const waiter of this.waiters) {
        try {
          waiter.reject?.(new Error("连接已关闭"));
        } catch (_) {}
        clearTimeout(waiter.timer);
      }
      this.waiters = [];
      this.readLoopPromise = null;
    } catch (err) {
      console.error("MavlinkFtpClient: close error", err);
    }
  }

  async open(baudRate, waitHeartbeatMs = 3000) {
    const timeoutMs = 10000;
    if (!this.port.readable || !this.port.writable) {
      await Promise.race([
        this.port.open({ baudRate }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("打开串口超时")), timeoutMs)),
      ]);
    }

    try {
      // Acquire writer/reader; if this fails, surface a clear error
      this.writer = this.port.writable.getWriter();
      this.reader = this.port.readable.getReader();
    } catch (err) {
      throw new Error(`初始化串口读写失败：${err.message}`);
    }

    // Start read loop in background; don't await it here to avoid blocking callers
    this.readLoopPromise = this.readLoop().catch(() => {});

    // Wait for heartbeat to confirm remote system is alive
    try {
      console.log(`MavlinkFtpClient.open: waiting up to ${waitHeartbeatMs}ms for HEARTBEAT`);
      await this.waitForHeartbeat(waitHeartbeatMs);
      console.log("MavlinkFtpClient.open: HEARTBEAT received");
    } catch (err) {
      // If no heartbeat, close resources to avoid dangling open port
      try {
        await this.close();
      } catch (_) {}
      throw new Error(`未收到来自飞控的 HEARTBEAT：${err.message}`);
    }
  }

  waitForHeartbeat(timeoutMs = 3000) {
    if (this._gotHeartbeat) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._heartbeatWaiters = this._heartbeatWaiters.filter((w) => w.timer !== timer);
        reject(new Error("heartbeat timeout"));
      }, timeoutMs);
      this._heartbeatWaiters.push({ resolve, reject, timer });
    });
  }

  async readLoop() {
    try {
      if (this.verbose) console.log("MavlinkFtpClient: readLoop started");
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) {
          if (this.verbose) console.log("MavlinkFtpClient: reader done");
          break;
        }
        if (value) {
          // Append incoming bytes
          this.rxBuffer.push(...value);
          if (this.verbose) console.log(`MavlinkFtpClient: read ${value.length} bytes`);
          // Process frames in a non-blocking, batched way
          this.consumeFrames();
        }
        // Yield occasionally to keep UI responsive
        await Promise.resolve();
      }
    } catch {
      // Reader cancellation and disconnects are surfaced through request timeouts.
    }
  }

  consumeFrames() {
    // Process frames in batches to avoid long-running synchronous loops
    const MAX_ITER = 50;
    let iterations = 0;

    while (this.rxBuffer.length > 0 && iterations < MAX_ITER) {
      const magicIndex = this.rxBuffer.findIndex((byte) => byte === MAVLINK_V1_MAGIC || byte === MAVLINK_V2_MAGIC);
      if (magicIndex < 0) {
        this.rxBuffer.length = 0;
        return;
      }
      if (magicIndex > 0) {
        this.rxBuffer.splice(0, magicIndex);
      }

      const magic = this.rxBuffer[0];

      // Need at least the length byte
      if (this.rxBuffer.length < 2) {
        return;
      }

      const length = this.rxBuffer[1];

      const headerLength = magic === MAVLINK_V2_MAGIC ? 10 : 6;

      // For MAVLink v2 we need the incompatibility flags at index 2 to decide signature
      let signatureLength = 0;
      if (magic === MAVLINK_V2_MAGIC) {
        if (this.rxBuffer.length < 3) {
          return;
        }
        signatureLength = (this.rxBuffer[2] & 0x01) ? 13 : 0;
      }

      // Validate length is a finite number
      if (!Number.isFinite(length) || length < 0 || length > 255) {
        // Invalid length byte — skip this magic byte and continue
        this.rxBuffer.splice(0, 1);
        continue;
      }

      const frameLength = headerLength + length + 2 + signatureLength;
      if (this.rxBuffer.length < frameLength) {
        return;
      }

      const frame = this.rxBuffer.splice(0, frameLength);
      const message = magic === MAVLINK_V2_MAGIC ? this.parseV2Frame(frame) : this.parseV1Frame(frame);
      try {
        const kind = magic === MAVLINK_V2_MAGIC ? 'v2' : 'v1';
        if (this.logMsgIds.has(message.msgId)) {
          console.log(`MavlinkFtpClient.consumeFrames: parsed frame kind=${kind} msgId=${message.msgId} src=${message.srcSystem}/${message.srcComponent} payloadLen=${message.payload.length} frameLen=${frameLength}`);
        }
      } catch (e) {
        console.warn('MavlinkFtpClient.consumeFrames: parse log failed', e);
      }
      if (message) {
        try {
          this.handleMessage(message);
        } catch (err) {
          console.error("MavlinkFtpClient: handleMessage error", err);
        }
      }

      iterations += 1;
    }

    if (this.rxBuffer.length > 0) {
      // Schedule next batch to keep UI responsive
      setTimeout(() => this.consumeFrames(), 0);
    }
  }

  parseV2Frame(frame) {
    const buf = Uint8Array.from(frame);
    const length = buf[1];
    const srcSystem = buf[5];
    const srcComponent = buf[6];
    const msgId = buf[7] | (buf[8] << 8) | (buf[9] << 16);
    const payload = buf.slice(10, 10 + length);
    return { msgId, payload, srcSystem, srcComponent };
  }

  parseV1Frame(frame) {
    const buf = Uint8Array.from(frame);
    const length = buf[1];
    const srcSystem = buf[3];
    const srcComponent = buf[4];
    const msgId = buf[5];
    const payload = buf.slice(6, 6 + length);
    return { msgId, payload, srcSystem, srcComponent };
  }

  handleMessage(message) {
    try {
      if (this.logMsgIds.has(message.msgId)) {
        console.log(`MavlinkFtpClient.handleMessage: msgId=${message.msgId} payloadLen=${message.payload.length}`);
      }
      // Detect HEARTBEAT (msgId 0) and record source system/component
      if (message.msgId === 0) {
        try {
          const src = message.srcSystem ?? null;
          const comp = message.srcComponent ?? null;
          if (src !== null) {
            this.targetSystem = src;
          }
          if (comp !== null) {
            this.targetComponent = comp;
          }
          if (!this._gotHeartbeat) {
            this._gotHeartbeat = true;
            console.log(`MavlinkFtpClient: HEARTBEAT from system ${this.targetSystem} component ${this.targetComponent}`);
            // notify waiters
            for (const w of this._heartbeatWaiters) {
              clearTimeout(w.timer);
              try {
                w.resolve();
              } catch (e) {
                // ignore
              }
            }
            this._heartbeatWaiters = [];
          }
        } catch (e) {
          console.warn("MavlinkFtpClient: heartbeat handling error", e);
        }
        // Do not return here; allow FTP payload processing below when applicable
      }

      if (message.msgId !== FILE_TRANSFER_PROTOCOL_ID || message.payload.length < 15) {
        // Not a FTP message or payload too small
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

    // (debug logs removed)

    const matching = this.waiters.filter((waiter) => waiter.matches(ftpMessage));
    for (const waiter of matching) {
      try {
        // Resolve waiters for both ACK and NAK so caller can decide how to handle NAK (e.g., EndOfFile)
        try {
          waiter.resolve(ftpMessage);
        } catch (err) {
          console.error("MavlinkFtpClient: waiter.resolve threw", err);
        }
      } catch (err) {
        console.error("MavlinkFtpClient: waiter handler threw", err);
      }
      clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter((item) => item !== waiter);
    }
    } catch (err) {
      console.error("MavlinkFtpClient: handleMessage error", err);
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
      const expectedSeq = ((sequence + 1) & 0xffff);
      const waiter = {
        matches: (message) => {
          const opcodeOk = message.opcode === FTP_OPCODE.ACK || message.opcode === FTP_OPCODE.NAK;
          const seqOk = message.sequence === expectedSeq;
          const reqOk = message.requestOpcode === requestOpcode;
          return opcodeOk && reqOk && seqOk;
        },
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          console.warn(`MavlinkFtpClient.waitForResponse: timeout seq=${sequence} expectedSeq=${expectedSeq} reqOp=${requestOpcode}`);
          reject(new Error("等待 MAVLink FTP 响应超时"));
        }, timeoutMs),
      };
      if (this.verbose) console.log(`MavlinkFtpClient.waitForResponse: waiting seq=${sequence} expectedSeq=${expectedSeq} reqOp=${requestOpcode}`);
      this.waiters.push(waiter);
    });
  }

  async request(command, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      console.log(`MavlinkFtpClient.request: attempt ${attempt} seq=${command.sequence} opcode=${command.opcode}`);
      const responsePromise = this.waitForResponse(command.sequence, command.opcode);
      await this.sendFtpCommand(command);
      try {
        return await responsePromise;
      } catch (error) {
        console.warn(`MavlinkFtpClient.request: attempt ${attempt} failed: ${error.message}`);
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
