const BEGIN_1 = 0x92;
const BEGIN_2 = 0x05;
const END = 0x26;

const TYPE_INFO = {
  0: { name: "INT8", size: 1, read: (view, offset) => view.getInt8(offset) },
  1: { name: "UINT8", size: 1, read: (view, offset) => view.getUint8(offset) },
  2: { name: "INT16", size: 2, read: (view, offset) => view.getInt16(offset, true) },
  3: { name: "UINT16", size: 2, read: (view, offset) => view.getUint16(offset, true) },
  4: { name: "INT32", size: 4, read: (view, offset) => view.getInt32(offset, true) },
  5: { name: "UINT32", size: 4, read: (view, offset) => view.getUint32(offset, true) },
  6: { name: "FLOAT", size: 4, read: (view, offset) => view.getFloat32(offset, true) },
  7: { name: "DOUBLE", size: 8, read: (view, offset) => view.getFloat64(offset, true) },
  8: { name: "BOOLEAN", size: 1, read: (view, offset) => view.getUint8(offset) !== 0 },
};

const PARAM_TYPE_INFO = {
  0: TYPE_INFO[0],
  1: TYPE_INFO[1],
  2: TYPE_INFO[2],
  3: TYPE_INFO[3],
  4: TYPE_INFO[4],
  5: TYPE_INFO[5],
  6: TYPE_INFO[6],
  7: TYPE_INFO[7],
};

const textDecoder = new TextDecoder("utf-8", { fatal: false });

function ensureAvailable(view, offset, size, label) {
  if (offset + size > view.byteLength) {
    throw new Error(`${label} 超出文件长度`);
  }
}

function readFixedString(bytes) {
  const end = bytes.indexOf(0);
  const trimmed = end >= 0 ? bytes.slice(0, end) : bytes;
  return textDecoder.decode(trimmed).replace(/\s+$/u, "");
}

function readBytes(view, offset, size, label) {
  ensureAvailable(view, offset, size, label);
  return {
    value: new Uint8Array(view.buffer, view.byteOffset + offset, size),
    offset: offset + size,
  };
}

function readUint8(view, offset, label) {
  ensureAvailable(view, offset, 1, label);
  return { value: view.getUint8(offset), offset: offset + 1 };
}

function readUint32(view, offset, label) {
  ensureAvailable(view, offset, 4, label);
  return { value: view.getUint32(offset, true), offset: offset + 4 };
}

function readTypedValue(view, offset, type, map, label) {
  const info = map[type];
  if (!info) {
    throw new Error(`${label} 使用了暂不支持的类型 ${type}`);
  }
  ensureAvailable(view, offset, info.size, label);
  return { value: info.read(view, offset), offset: offset + info.size };
}

function buildFieldNames(element) {
  if (element.number <= 1) {
    return [element.name];
  }
  return Array.from({ length: element.number }, (_, index) => `${element.name}[${index}]`);
}

function payloadSize(bus) {
  return bus.elements.reduce((sum, element) => {
    const info = TYPE_INFO[element.type];
    return sum + (info ? info.size * element.number : 0);
  }, 0);
}

function parseParamGroups(view, startOffset, nameLen, warnings) {
  let offset = startOffset;
  const paramGroups = [];

  try {
    let scalar = readUint8(view, offset, "参数组数量");
    const numParamGroups = scalar.value;
    offset = scalar.offset;

    for (let i = 0; i < numParamGroups; i += 1) {
      let result = readBytes(view, offset, nameLen, `参数组 ${i} 名称`);
      const groupName = readFixedString(result.value);
      offset = result.offset;

      scalar = readUint32(view, offset, `参数组 ${groupName} 参数数量`);
      const paramCount = scalar.value;
      offset = scalar.offset;

      const params = [];
      for (let j = 0; j < paramCount; j += 1) {
        result = readBytes(view, offset, nameLen, `参数 ${j} 名称`);
        const paramName = readFixedString(result.value);
        offset = result.offset;

        scalar = readUint8(view, offset, `参数 ${paramName} 类型`);
        const type = scalar.value;
        offset = scalar.offset;

        const typeInfo = PARAM_TYPE_INFO[type];
        if (!typeInfo) {
          warnings.push(`参数 ${paramName || "(空名称)"} 使用了未知类型 ${type}，已停止解析参数区并继续扫描日志帧`);
          params.push({
            name: paramName,
            type,
            typeName: `TYPE_${type}`,
            value: null,
            unsupported: true,
          });
          paramGroups.push({ name: groupName, params });
          return { paramGroups, offset: startOffset, complete: false };
        }

        const typed = readTypedValue(view, offset, type, PARAM_TYPE_INFO, `参数 ${paramName} 值`);
        offset = typed.offset;
        params.push({
          name: paramName,
          type,
          typeName: typeInfo.name,
          value: typed.value,
        });
      }

      paramGroups.push({ name: groupName, params });
    }

    return { paramGroups, offset, complete: true };
  } catch (error) {
    warnings.push(`参数区解析未完成：${error.message}。已保留 bus 定义并从参数区起点扫描日志帧`);
    return { paramGroups, offset: startOffset, complete: false };
  }
}

function parseHeader(view) {
  let offset = 0;
  const warnings = [];
  ensureAvailable(view, offset, 12, "日志头");

  const version = view.getUint16(offset, true);
  offset += 2;
  const timestamp = view.getUint32(offset, true);
  offset += 4;
  const maxNameLen = view.getUint16(offset, true);
  offset += 2;
  const maxDescLen = view.getUint16(offset, true);
  offset += 2;
  const maxModelInfoLen = view.getUint16(offset, true);
  offset += 2;

  let description = "";
  let modelInfo = "";
  let result = readBytes(view, offset, maxDescLen, "描述信息");
  description = readFixedString(result.value);
  offset = result.offset;

  result = readBytes(view, offset, maxModelInfoLen, "模型信息");
  modelInfo = readFixedString(result.value);
  offset = result.offset;

  let scalar = readUint8(view, offset, "消息总线数量");
  const numBus = scalar.value;
  offset = scalar.offset;

  const buses = [];
  const busById = new Map();
  const nameLen = maxNameLen > 0 ? maxNameLen : 25;

  for (let i = 0; i < numBus; i += 1) {
    result = readBytes(view, offset, nameLen, `消息 ${i} 名称`);
    const name = readFixedString(result.value);
    offset = result.offset;

    scalar = readUint8(view, offset, `消息 ${name} ID`);
    const id = scalar.value;
    offset = scalar.offset;

    scalar = readUint8(view, offset, `消息 ${name} 字段数量`);
    const numElements = scalar.value;
    offset = scalar.offset;

    const elements = [];
    for (let j = 0; j < numElements; j += 1) {
      result = readBytes(view, offset, nameLen, `消息 ${name} 字段 ${j} 名称`);
      const elementName = readFixedString(result.value);
      offset = result.offset;

      ensureAvailable(view, offset, 4, `消息 ${name} 字段 ${elementName}`);
      const type = view.getUint16(offset, true);
      offset += 2;
      const number = view.getUint16(offset, true);
      offset += 2;

      elements.push({
        name: elementName,
        type,
        typeName: TYPE_INFO[type]?.name ?? `TYPE_${type}`,
        number,
      });
    }

    const bus = {
      id,
      name,
      elements,
      payloadSize: 0,
      frames: [],
      fields: [],
    };
    bus.payloadSize = payloadSize(bus);
    bus.fields = bus.elements.flatMap(buildFieldNames).concat("delta_ts");
    buses.push(bus);
    busById.set(id, bus);
  }

  const paramSectionOffset = offset;
  const paramResult = parseParamGroups(view, paramSectionOffset, nameLen, warnings);

  return {
    version,
    timestamp,
    maxNameLen,
    maxDescLen,
    maxModelInfoLen,
    numBus,
    buses,
    busById,
    paramGroups: paramResult.paramGroups,
    warnings,
    description,
    modelInfo,
    offset: paramResult.offset,
  };
}

function readFramePayload(view, bus, payloadOffset) {
  let offset = payloadOffset;
  const row = {};
  const values = [];

  for (const element of bus.elements) {
    for (let i = 0; i < element.number; i += 1) {
      const fieldName = element.number <= 1 ? element.name : `${element.name}[${i}]`;
      const typed = readTypedValue(view, offset, element.type, TYPE_INFO, `${bus.name}.${fieldName}`);
      offset = typed.offset;
      row[fieldName] = typed.value;
      values.push(typed.value);
    }
  }

  return { row, values };
}

function parseFrames(view, header) {
  let offset = header.offset;
  const previousTimestamp = new Map();
  let totalFrames = 0;
  let skippedBytes = 0;

  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== BEGIN_1 || view.getUint8(offset + 1) !== BEGIN_2) {
      offset += 1;
      skippedBytes += 1;
      continue;
    }

    const messageId = view.getUint8(offset + 2);
    const bus = header.busById.get(messageId);
    if (!bus) {
      offset += 1;
      skippedBytes += 1;
      continue;
    }

    const payloadOffset = offset + 3;
    const endOffset = payloadOffset + bus.payloadSize;
    if (endOffset >= view.byteLength) {
      break;
    }

    if (view.getUint8(endOffset) !== END) {
      offset += 1;
      skippedBytes += 1;
      continue;
    }

    try {
      const frame = readFramePayload(view, bus, payloadOffset);
      const timestamp = Number(frame.row.timestamp);
      const hasTimestamp = Number.isFinite(timestamp);
      let deltaTs = 0;

      if (hasTimestamp) {
        const previous = previousTimestamp.get(bus.id);
        deltaTs = previous === undefined ? 0 : (timestamp - previous) >>> 0;
        previousTimestamp.set(bus.id, timestamp);
      }

      bus.frames.push({
        ...frame.row,
        delta_ts: deltaTs,
      });
      totalFrames += 1;
      offset = endOffset + 1;
    } catch {
      offset += 1;
      skippedBytes += 1;
    }
  }

  return { totalFrames, skippedBytes };
}

export function parseMlog(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const header = parseHeader(view);
  const frameStats = parseFrames(view, header);

  return {
    ...header,
    totalFrames: frameStats.totalFrames,
    skippedBytes: frameStats.skippedBytes,
  };
}

export function busToCsv(bus) {
  const escapeCell = (value) => {
    const text = value === undefined || value === null ? "" : String(value);
    if (/[",\n\r]/u.test(text)) {
      return `"${text.replace(/"/gu, '""')}"`;
    }
    return text;
  };

  const rows = [bus.fields];
  for (const frame of bus.frames) {
    rows.push(bus.fields.map((field) => frame[field]));
  }

  return rows.map((row) => row.map(escapeCell).join(",")).join("\n");
}

export function collectChartSeries(result, limit = 6) {
  const series = [];

  for (const bus of result.buses) {
    if (bus.frames.length < 2) {
      continue;
    }

    const scalarFields = bus.fields.filter((field) => {
      if (field === "delta_ts") {
        return false;
      }
      return bus.frames.some((frame) => typeof frame[field] === "number" && Number.isFinite(frame[field]));
    });

    const xField = scalarFields.includes("timestamp") ? "timestamp" : null;
    const candidates = scalarFields.filter((field) => field !== "timestamp");

    for (const field of candidates) {
      const points = bus.frames
        .map((frame, index) => ({
          x: xField ? Number(frame[xField]) : index,
          y: Number(frame[field]),
        }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

      if (points.length < 2) {
        continue;
      }

      const first = points[0].y;
      const varies = points.some((point) => Math.abs(point.y - first) > 1e-9);
      if (!varies) {
        continue;
      }

      series.push({
        busId: bus.id,
        busName: bus.name || `msg_${bus.id}`,
        field,
        xLabel: xField || "frame",
        points,
      });

      if (series.length >= limit) {
        return series;
      }
    }
  }

  return series;
}
