const MAVLINK_V1_MAGIC = 0xfe;
const MAVLINK_V2_MAGIC = 0xfd;
const FILE_TRANSFER_PROTOCOL_ID = 110;
const FILE_TRANSFER_PROTOCOL_CRC_EXTRA = 84;
const FTP_PAYLOAD_SIZE = 251;

const FTP_OPCODE = {
  TERMINATE_SESSION: 1,
  RESET_SESSIONS: 2,
  LIST_DIRECTORY: 3,
  OPEN_FILE_RO: 4,
  READ_FILE: 5,
  BURST_READ_FILE: 15,
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

function formatFtpError(response) {
  const errorCode = response.data[0];
  const errorName = FTP_ERROR[errorCode] ?? errorCode;
  const errno = response.data.length > 1 ? `, errno=${response.data[1]}` : "";
  return `MAVLink FTP NAK: ${errorName} (request=${response.requestOpcode}, code=${errorCode}${errno})`;
}

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

function isSequenceAtOrAfter(sequence, expected) {
  return ((sequence - expected) & 0xffff) < 0x8000;
}

function makeAbortError() {
  if (typeof DOMException === "function") {
    return new DOMException("传输已取消", "AbortError");
  }
  const error = new Error("传输已取消");
  error.name = "AbortError";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason ?? makeAbortError();
  }
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
    this._messageQueue = [];
    this.logMsgIds = new Set();
    // Verbose general logs (reads, lifecycle). Keep false to minimize noise.
    this.verbose = false;
  }

  async close() {
    try {
      // Stop reader
      const reader = this.reader;
      if (reader) {
        try {
          await reader.cancel();
        } catch (e) {
          console.warn("MavlinkFtpClient: reader.cancel failed", e);
        }

        if (this.readLoopPromise) {
          try {
            await Promise.race([
              this.readLoopPromise,
              new Promise((resolve) => setTimeout(resolve, 300)),
            ]);
          } catch (_) {
            // readLoop cancellation is expected while closing.
          }
        }

        try {
          reader.releaseLock();
        } catch (e) {
          // ignore
        }
        if (this.reader === reader) {
          this.reader = null;
        }
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
      this._messageQueue = [];
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
    this.readLoopPromise = this.readLoop(this.reader).catch(() => {});

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

  async readLoop(reader) {
    try {
      if (this.verbose) console.log("MavlinkFtpClient: readLoop started");
      while (true) {
        const { value, done } = await reader.read();
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
    let payload = buf.slice(10, 10 + length);
    if (msgId === FILE_TRANSFER_PROTOCOL_ID && payload.length < 254) {
      const paddedPayload = new Uint8Array(254);
      paddedPayload.set(payload);
      payload = paddedPayload;
    }
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

    let handled = false;
    const remainingWaiters = [];
    for (const waiter of this.waiters) {
      if (!handled && waiter.matches(ftpMessage)) {
        clearTimeout(waiter.timer);
        try {
          waiter.resolve(ftpMessage);
        } catch (err) {
          console.error("MavlinkFtpClient: waiter.resolve threw", err);
        }
        handled = true;
      } else {
        remainingWaiters.push(waiter);
      }
    }
    this.waiters = remainingWaiters;

    if (!handled) {
      this._messageQueue.push(ftpMessage);
      if (this._messageQueue.length > 5000) {
        this._messageQueue.shift();
      }
    }
    } catch (err) {
      console.error("MavlinkFtpClient: handleMessage error", err);
    }
  }

  buildFtpPayload({ sequence, session = 0, opcode, size, offset, data }) {
    const payload = new Uint8Array(FTP_PAYLOAD_SIZE);
    writeUint16LE(payload, 0, sequence);
    payload[2] = session;
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

  waitForResponse(sequence, requestOpcode, timeoutMs = 3000, signal = null) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? makeAbortError());
        return;
      }

      const nextSequence = (sequence + 1) & 0xffff;

      const isMatch = (message) => {
        const opcodeOk = message.opcode === FTP_OPCODE.ACK || message.opcode === FTP_OPCODE.NAK;
        const seqOk = message.sequence === nextSequence;
        const reqOk = message.requestOpcode === requestOpcode;
        return opcodeOk && reqOk && seqOk;
      };

      const qIndex = this._messageQueue.findIndex(isMatch);
      if (qIndex >= 0) {
        const msg = this._messageQueue.splice(qIndex, 1)[0];
        return resolve(msg);
      }

      let abortHandler = null;
      const cleanup = () => {
        clearTimeout(waiter.timer);
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
        }
      };
      const waiter = {
        matches: isMatch,
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          console.warn(`MavlinkFtpClient.waitForResponse: timeout seq=${sequence}/${nextSequence} reqOp=${requestOpcode}`);
          waiter.reject(new Error("等待 MAVLink FTP 响应超时"));
        }, timeoutMs),
      };
      abortHandler = () => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        waiter.reject(signal.reason ?? makeAbortError());
      };
      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
      if (this.verbose) console.log(`MavlinkFtpClient.waitForResponse: waiting seq=${sequence}/${nextSequence} reqOp=${requestOpcode}`);
      this.waiters.push(waiter);
    });
  }

  waitForFtpMessage(matches, timeoutMs = 3000, signal = null) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? makeAbortError());
        return;
      }

      const qIndex = this._messageQueue.findIndex(matches);
      if (qIndex >= 0) {
        const msg = this._messageQueue.splice(qIndex, 1)[0];
        return resolve(msg);
      }

      let abortHandler = null;
      const cleanup = () => {
        clearTimeout(waiter.timer);
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
        }
      };
      const waiter = {
        matches,
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          waiter.reject(new Error("等待 MAVLink FTP 响应超时"));
        }, timeoutMs),
      };
      abortHandler = () => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        waiter.reject(signal.reason ?? makeAbortError());
      };
      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  async settleFtpStream(durationMs = 300) {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    this.rxBuffer.length = 0;
    this._messageQueue.length = 0;
    this.waiters = this.waiters.filter((waiter) => {
      clearTimeout(waiter.timer);
      try {
        waiter.reject?.(new Error("FTP stream settled"));
      } catch (_) {}
      return false;
    });
  }

  async request(command, retries = 3, signal = null) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      throwIfAborted(signal);
      if (this.verbose) console.log(`MavlinkFtpClient.request: attempt ${attempt} seq=${command.sequence} opcode=${command.opcode}`);
      const responsePromise = this.waitForResponse(command.sequence, command.opcode, 3000, signal);
      await this.sendFtpCommand(command);
      try {
        const response = await responsePromise;
        this.ftpSeq = (response.sequence + 1) & 0xffff;
        return response;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        console.warn(`MavlinkFtpClient.request: attempt ${attempt} failed: ${error.message}`);
        if (attempt === retries) {
          throw error;
        }
      }
    }
    throw new Error("MAVLink FTP 请求失败");
  }

  nextFtpSequence() {
    const sequence = this.ftpSeq;
    this.ftpSeq = (this.ftpSeq + 2) & 0xffff;
    return sequence;
  }

  async listDirectory(path) {
    const encoder = new TextEncoder();
    const pathBytes = encoder.encode(path);
    const entries = [];
    let offset = 0;

    while (true) {
      const sequence = this.nextFtpSequence();
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
        throw new Error(formatFtpError(response));
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

  async openFileReadOnly(path, { signal = null } = {}) {
    const encoder = new TextEncoder();
    const pathBytes = encoder.encode(path);
    const sequence = this.nextFtpSequence();
    const response = await this.request({
      sequence,
      opcode: FTP_OPCODE.OPEN_FILE_RO,
      size: pathBytes.length,
      offset: 0,
      data: pathBytes,
    }, 3, signal);

    if (response.opcode === FTP_OPCODE.NAK) {
      throw new Error(formatFtpError(response));
    }
    if (response.opcode !== FTP_OPCODE.ACK) {
      throw new Error(`未知 MAVLink FTP 响应 opcode: ${response.opcode}`);
    }

    return {
      session: response.session,
      size: response.data.length >= 4 ? readUint32LE(response.data, 0) : null,
    };
  }

  async terminateSession(session) {
    const sequence = this.nextFtpSequence();
    await this.sendFtpCommand({
      sequence,
      session,
      opcode: FTP_OPCODE.TERMINATE_SESSION,
      size: 0,
      offset: 0,
      data: new Uint8Array(0),
    });
  }

  async resetSessions() {
    const sequence = this.nextFtpSequence();
    try {
      await this.sendFtpCommand({
        sequence,
        opcode: FTP_OPCODE.RESET_SESSIONS,
        size: 0,
        offset: 0,
        data: new Uint8Array(0),
      });
    } catch (error) {
      console.warn(`发送 MAVLink FTP 重置会话失败：${error.message}`);
    }
  }

  async readFileChunk(session, offset, size, { signal = null } = {}) {
    const sequence = this.nextFtpSequence();
    const response = await this.request({
      sequence,
      session,
      opcode: FTP_OPCODE.READ_FILE,
      size,
      offset,
      data: new Uint8Array(0),
    }, 3, signal);

    if (response.opcode === FTP_OPCODE.NAK) {
      const errorCode = response.data[0];
      if (errorCode === 6) {
        return { data: new Uint8Array(0), eof: true };
      }
      throw new Error(formatFtpError(response));
    }
    if (response.opcode !== FTP_OPCODE.ACK) {
      throw new Error(`未知 MAVLink FTP 响应 opcode: ${response.opcode}`);
    }

    return { data: response.data, eof: false, offset: response.offset };
  }

  async burstReadFile(session, expectedSize, { chunkSize = 239, onProgress = null, path = "", signal = null } = {}) {
    throwIfAborted(signal);
    if (!Number.isFinite(expectedSize) || expectedSize < 0) {
      throw new Error("飞控未返回有效文件大小，无法可靠下载。");
    }

    const file = new Uint8Array(expectedSize);
    let expectedOffset = 0;
    let receivedBytes = 0;

    const reportProgress = (chunkBytes = 0) => {
      onProgress?.({
        path,
        loaded: Math.min(receivedBytes, expectedSize),
        total: expectedSize,
        chunkBytes,
      });
    };

    const storeChunk = (offset, data) => {
      if (data.length === 0 || offset >= expectedSize) {
        return;
      }
      const boundedLength = Math.min(data.length, expectedSize - offset);
      file.set(data.slice(0, boundedLength), offset);
      expectedOffset = offset + boundedLength;
      receivedBytes += boundedLength;
      reportProgress(boundedLength);
    };

    while (true) {
      throwIfAborted(signal);
      let retryCount = 0;
      let burstEnded = false;

      while (true) {
        throwIfAborted(signal);
        const sequence = this.nextFtpSequence();
        await this.sendFtpCommand({
          sequence,
          session,
          opcode: FTP_OPCODE.BURST_READ_FILE,
          size: chunkSize,
          offset: expectedOffset,
          data: new Uint8Array(0),
        });

        try {
          let expectedIncomingSequence = (sequence + 1) & 0xffff;
          let sawRequestedOffset = false;
          while (true) {
            throwIfAborted(signal);
            const message = await this.waitForFtpMessage((ftpMessage) => {
              if (ftpMessage.requestOpcode !== FTP_OPCODE.BURST_READ_FILE) return false;
              if (ftpMessage.session !== session) return false;
              if (ftpMessage.opcode !== FTP_OPCODE.ACK && ftpMessage.opcode !== FTP_OPCODE.NAK) return false;
              return ftpMessage.opcode === FTP_OPCODE.NAK || isSequenceAtOrAfter(ftpMessage.sequence, expectedIncomingSequence);
            }, 3000, signal);

            if (message.opcode === FTP_OPCODE.NAK) {
              this.ftpSeq = (message.sequence + 1) & 0xffff;
              const errorCode = message.data[0];
              if (errorCode === 6) {
                if (expectedOffset >= expectedSize) {
                  burstEnded = true;
                  break;
                }
                throw new Error(`BurstReadFile 提前 EOF：已读取 ${expectedOffset} B，应为 ${expectedSize} B`);
              }
              throw new Error(formatFtpError(message));
            }

            if (message.offset >= expectedSize) {
              if (!sawRequestedOffset) {
                continue;
              }
              this.ftpSeq = (message.sequence + 1) & 0xffff;
              expectedIncomingSequence = (message.sequence + 1) & 0xffff;
              continue;
            }

            if (message.offset < expectedOffset) {
              this.ftpSeq = (message.sequence + 1) & 0xffff;
              expectedIncomingSequence = (message.sequence + 1) & 0xffff;
              continue;
            }

            if (message.offset > expectedOffset) {
              if (!sawRequestedOffset) {
                continue;
              }
              this.ftpSeq = (message.sequence + 1) & 0xffff;
              expectedIncomingSequence = (message.sequence + 1) & 0xffff;
              if (message.burstComplete) {
                console.warn(`MAVLink FTP burst gap: expected offset ${expectedOffset}, got ${message.offset}; retry from missing offset`);
                burstEnded = false;
                break;
              }
              continue;
            }

            sawRequestedOffset = true;
            this.ftpSeq = (message.sequence + 1) & 0xffff;
            expectedIncomingSequence = (message.sequence + 1) & 0xffff;
            storeChunk(message.offset, message.data);

            if (expectedOffset >= expectedSize) {
              burstEnded = true;
              break;
            }

            if (message.burstComplete) {
              if (expectedOffset >= expectedSize) {
                burstEnded = true;
                break;
              }
              break;
            }
          }
          break;
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          retryCount += 1;
          if (retryCount > 3) {
            throw error;
          }
          console.warn(`MAVLink FTP burst retry ${retryCount} at offset ${expectedOffset}: ${error.message}`);
        }
      }

      if (burstEnded) {
        break;
      }
    }

    receivedBytes = expectedSize;
    reportProgress();
    return file.buffer;
  }

  async readFile(path, { size = null, chunkSize = 239, onProgress = null, signal = null } = {}) {
    throwIfAborted(signal);
    await this.resetSessions();
    await this.settleFtpStream();
    throwIfAborted(signal);
    const sessionInfo = await this.openFileReadOnly(path, { signal });
    const session = sessionInfo.session;
    const expectedSize = Number.isFinite(sessionInfo.size) ? sessionInfo.size : size;

    try {
      return await this.burstReadFile(session, expectedSize, { chunkSize, onProgress, path, signal });
    } catch (error) {
      await this.resetSessions();
      await this.settleFtpStream();
      throw error;
    } finally {
      try {
        await this.terminateSession(session);
      } catch (error) {
        console.warn(`关闭 MAVLink FTP 会话失败：${error.message}`);
      }
    }
  }
}
