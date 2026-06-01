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

const TIMESTAMP_FIELD_NAMES = ["timestamp", "timestamp_ms"];

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

function findTimestampFieldName(bus) {
  for (const element of bus.elements) {
    if (element.number === 1 && TIMESTAMP_FIELD_NAMES.includes(element.name)) {
      return element.name;
    }
  }
  return null;
}

function findParamValue(paramGroups, groupName, paramName) {
  const group = paramGroups.find((item) => item.name === groupName);
  if (!group) {
    return null;
  }
  const param = group.params.find((item) => item.name === paramName && !item.unsupported);
  return param ? param.value : null;
}

function parseModelInfoSections(modelInfo) {
  if (!modelInfo) {
    return [];
  }
  return modelInfo
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function numericRange(values) {
  let min = null;
  let max = null;

  for (const value of values) {
    if (!Number.isFinite(value)) {
      continue;
    }
    min = min === null ? value : Math.min(min, value);
    max = max === null ? value : Math.max(max, value);
  }

  return { min, max };
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
      timestampField: null,
    };
    bus.payloadSize = payloadSize(bus);
    bus.fields = bus.elements.flatMap(buildFieldNames).concat("delta_ts");
    bus.timestampField = findTimestampFieldName(bus);
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
  const issues = {
    unknownMessageIds: new Map(),
    badEndMarkers: 0,
    truncatedFrames: 0,
    payloadReadErrors: 0,
  };

  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== BEGIN_1 || view.getUint8(offset + 1) !== BEGIN_2) {
      offset += 1;
      skippedBytes += 1;
      continue;
    }

    const messageId = view.getUint8(offset + 2);
    const bus = header.busById.get(messageId);
    if (!bus) {
      issues.unknownMessageIds.set(messageId, (issues.unknownMessageIds.get(messageId) ?? 0) + 1);
      offset += 1;
      skippedBytes += 1;
      continue;
    }

    const payloadOffset = offset + 3;
    const endOffset = payloadOffset + bus.payloadSize;
    if (endOffset >= view.byteLength) {
      issues.truncatedFrames += 1;
      break;
    }

    if (view.getUint8(endOffset) !== END) {
      issues.badEndMarkers += 1;
      offset += 1;
      skippedBytes += 1;
      continue;
    }

    try {
      const frame = readFramePayload(view, bus, payloadOffset);
      const timestamp = Number(bus.timestampField ? frame.row[bus.timestampField] : Number.NaN);
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
      issues.payloadReadErrors += 1;
      offset += 1;
      skippedBytes += 1;
    }
  }

  return { totalFrames, skippedBytes, issues };
}

function appendFrameWarnings(warnings, frameStats) {
  if (frameStats.skippedBytes > 0) {
    warnings.push(`扫描数据帧时跳过 ${frameStats.skippedBytes} 字节，可能包含损坏、填充或未识别数据`);
  }

  if (frameStats.issues.unknownMessageIds.size > 0) {
    const examples = Array.from(frameStats.issues.unknownMessageIds.entries())
      .slice(0, 5)
      .map(([id, count]) => `${id}(${count}次)`)
      .join("，");
    warnings.push(`发现未定义消息 ID：${examples}`);
  }

  if (frameStats.issues.badEndMarkers > 0) {
    warnings.push(`发现 ${frameStats.issues.badEndMarkers} 个帧尾标记不匹配的数据段`);
  }

  if (frameStats.issues.truncatedFrames > 0) {
    warnings.push(`发现 ${frameStats.issues.truncatedFrames} 个不完整数据帧，文件可能在写入过程中结束`);
  }

  if (frameStats.issues.payloadReadErrors > 0) {
    warnings.push(`发现 ${frameStats.issues.payloadReadErrors} 个 payload 读取失败的数据帧`);
  }
}

function computeDerivedTiming(result) {
  const candidates = [];
  const ranges = [];

  for (const bus of result.buses) {
    if (!bus.timestampField || bus.frames.length === 0) {
      continue;
    }

    let first = null;
    let min = null;
    let max = null;
    let samples = 0;

    for (const frame of bus.frames) {
      const timestamp = Number(frame[bus.timestampField]);
      if (!Number.isFinite(timestamp)) {
        continue;
      }
      first = first === null ? timestamp : first;
      if (timestamp !== 0) {
        min = min === null ? timestamp : Math.min(min, timestamp);
        max = max === null ? timestamp : Math.max(max, timestamp);
      }
      samples += 1;
    }

    if (samples === 0) {
      continue;
    }

    if (samples > 1 && first > 0) {
      candidates.push(first);
    }

    if (min !== null && max !== null) {
      ranges.push({
        busId: bus.id,
        busName: bus.name,
        field: bus.timestampField,
        first,
        min,
        max,
        samples,
      });
    }
  }

  let globalTimestampStart = null;
  let globalTimestampSource = "none";

  if (candidates.length > 0) {
    globalTimestampStart = Math.min(...candidates);
    globalTimestampSource = "bus_first_sample";
  } else if (result.timestamp > 0) {
    globalTimestampStart = result.timestamp;
    globalTimestampSource = "header_timestamp";
  }

  let minTimestamp = null;
  let maxTimestamp = null;
  if (ranges.length > 0) {
    const range = numericRange(ranges.flatMap((item) => [item.min, item.max]));
    minTimestamp = range.min;
    maxTimestamp = range.max;
  }

  const durationMs =
    minTimestamp !== null && maxTimestamp !== null ? Math.max(0, maxTimestamp - minTimestamp) : null;

  return {
    timestampRanges: ranges,
    globalTimestampStart,
    globalTimestampSource,
    minTimestamp,
    maxTimestamp,
    durationMs,
    headerTimestampMeaning: "systime_now_ms at log start",
  };
}

function deriveRecordedInfo(result) {
  return {
    firmware: null,
    kernel: null,
    target: null,
    vehicle: null,
    airframe: findParamValue(result.paramGroups, "CONTROL", "AIRFRAME"),
    modelInfoSections: parseModelInfoSections(result.modelInfo),
  };
}

export function parseMlog(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const header = parseHeader(view);
  const frameStats = parseFrames(view, header);
  appendFrameWarnings(header.warnings, frameStats);
  const baseResult = {
    ...header,
    totalFrames: frameStats.totalFrames,
    skippedBytes: frameStats.skippedBytes,
  };
  let timing = {
    timestampRanges: [],
    globalTimestampStart: null,
    globalTimestampSource: "none",
    minTimestamp: null,
    maxTimestamp: null,
    durationMs: null,
    headerTimestampMeaning: "systime_now_ms at log start",
  };
  let recordedInfo = {
    firmware: null,
    kernel: null,
    target: null,
    vehicle: null,
    airframe: null,
    modelInfoSections: [],
  };

  try {
    timing = computeDerivedTiming(baseResult);
  } catch (error) {
    baseResult.warnings.push(`日志时间摘要推导失败：${error.message}`);
  }

  try {
    recordedInfo = deriveRecordedInfo(baseResult);
  } catch (error) {
    baseResult.warnings.push(`日志配置摘要推导失败：${error.message}`);
  }

  return {
    ...baseResult,
    ...timing,
    recordedInfo,
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

    const xField = bus.timestampField && scalarFields.includes(bus.timestampField) ? bus.timestampField : null;
    const candidates = scalarFields.filter((field) => field !== xField);

    for (const field of candidates) {
      const points = bus.frames
        .map((frame, index) => ({
          x: xField
            ? (Number(frame[xField]) - (result.globalTimestampStart ?? Number(frame[xField]))) * 0.001
            : index,
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
        xLabel: xField ? "time_s" : "frame",
        points,
      });

      if (series.length >= limit) {
        return series;
      }
    }
  }

  return series;
}
