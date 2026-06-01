import assert from "node:assert/strict";
import { collectChartSeries, parseMlog } from "../src/mlogParser.js";

const NAME_LEN = 25;
const DESC_LEN = 16;
const MODEL_LEN = 16;

function fixedString(text, length) {
  const bytes = new Uint8Array(length);
  new TextEncoder().encodeInto(text, bytes);
  return [...bytes];
}

function u16(value) {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value) {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function f32(value) {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setFloat32(0, value, true);
  return [...new Uint8Array(buffer)];
}

function frame(msgId, timestamp, altitude, speed) {
  return [0x92, 0x05, msgId, ...u32(timestamp), ...f32(altitude), ...f32(speed), 0x26];
}

const bytes = [
  ...u16(2),
  ...u32(123456),
  ...u16(NAME_LEN),
  ...u16(DESC_LEN),
  ...u16(MODEL_LEN),
  ...fixedString("test log", DESC_LEN),
  ...fixedString("test model", MODEL_LEN),
  1,
  ...fixedString("INS_Out", NAME_LEN),
  0,
  3,
  ...fixedString("timestamp", NAME_LEN),
  ...u16(5),
  ...u16(1),
  ...fixedString("altitude", NAME_LEN),
  ...u16(6),
  ...u16(1),
  ...fixedString("speed", NAME_LEN),
  ...u16(6),
  ...u16(1),
  0,
  ...frame(0, 1000, 10.5, 3.1),
  ...frame(0, 1020, 11.0, 3.4),
  ...frame(0, 1040, 12.25, 4.0),
];

const result = parseMlog(new Uint8Array(bytes).buffer);

assert.equal(result.version, 2);
assert.equal(result.description, "test log");
assert.equal(result.buses.length, 1);
assert.equal(result.buses[0].name, "INS_Out");
assert.equal(result.buses[0].timestampField, "timestamp");
assert.equal(result.totalFrames, 3);
assert.equal(result.buses[0].frames[1].delta_ts, 20);
assert.equal(result.globalTimestampStart, 1000);
assert.equal(result.globalTimestampSource, "bus_first_sample");
assert.equal(result.durationMs, 40);
assert.equal(result.minTimestamp, 1000);
assert.equal(result.maxTimestamp, 1040);

const series = collectChartSeries(result, 6);
assert.equal(series.length, 2);
assert.equal(series[0].field, "altitude");
assert.equal(series[0].xLabel, "time_s");
assert.equal(series[0].points[0].x, 0);

const largeBytes = [
  ...u16(2),
  ...u32(0),
  ...u16(NAME_LEN),
  ...u16(DESC_LEN),
  ...u16(MODEL_LEN),
  ...fixedString("large log", DESC_LEN),
  ...fixedString("test model", MODEL_LEN),
  1,
  ...fixedString("INS_Out", NAME_LEN),
  0,
  3,
  ...fixedString("timestamp", NAME_LEN),
  ...u16(5),
  ...u16(1),
  ...fixedString("altitude", NAME_LEN),
  ...u16(6),
  ...u16(1),
  ...fixedString("speed", NAME_LEN),
  ...u16(6),
  ...u16(1),
  0,
];
for (let i = 0; i < 70000; i += 1) {
  largeBytes.push(...frame(0, 1000 + i, i, 0));
}
const largeResult = parseMlog(new Uint8Array(largeBytes).buffer);
assert.equal(largeResult.totalFrames, 70000);
assert.equal(largeResult.durationMs, 69999);

const bytesWithUnknownParamType = [
  ...u16(2),
  ...u32(123456),
  ...u16(NAME_LEN),
  ...u16(DESC_LEN),
  ...u16(MODEL_LEN),
  ...fixedString("test log", DESC_LEN),
  ...fixedString("test model", MODEL_LEN),
  1,
  ...fixedString("INS_Out", NAME_LEN),
  0,
  3,
  ...fixedString("timestamp", NAME_LEN),
  ...u16(5),
  ...u16(1),
  ...fixedString("altitude", NAME_LEN),
  ...u16(6),
  ...u16(1),
  ...fixedString("speed", NAME_LEN),
  ...u16(6),
  ...u16(1),
  1,
  ...fixedString("FMS", NAME_LEN),
  ...u32(1),
  ...fixedString("CUSTOM_PARAM", NAME_LEN),
  23,
  ...frame(0, 2000, 21.5, 5.1),
  ...frame(0, 2020, 22.0, 5.4),
];

const unknownParamResult = parseMlog(new Uint8Array(bytesWithUnknownParamType).buffer);
assert.equal(unknownParamResult.totalFrames, 2);
assert.equal(unknownParamResult.paramGroups[0].params[0].unsupported, true);
assert.match(unknownParamResult.warnings[0], /未知类型 23/u);
assert.equal(unknownParamResult.recordedInfo.airframe, null);

const bytesWithTimestampMs = [
  ...u16(2),
  ...u32(500),
  ...u16(NAME_LEN),
  ...u16(DESC_LEN),
  ...u16(MODEL_LEN),
  ...fixedString("ts ms log", DESC_LEN),
  ...fixedString("test model", MODEL_LEN),
  1,
  ...fixedString("GPS", NAME_LEN),
  0,
  2,
  ...fixedString("timestamp_ms", NAME_LEN),
  ...u16(5),
  ...u16(1),
  ...fixedString("speed", NAME_LEN),
  ...u16(6),
  ...u16(1),
  0,
  0x92, 0x05, 0, ...u32(500), ...f32(1.2), 0x26,
  0x92, 0x05, 0, ...u32(540), ...f32(1.4), 0x26,
];

const timestampMsResult = parseMlog(new Uint8Array(bytesWithTimestampMs).buffer);
assert.equal(timestampMsResult.buses[0].timestampField, "timestamp_ms");
assert.equal(timestampMsResult.buses[0].frames[1].delta_ts, 40);
assert.equal(timestampMsResult.globalTimestampStart, 500);
assert.equal(timestampMsResult.durationMs, 40);

const bytesWithAirframeParam = [
  ...u16(2),
  ...u32(0),
  ...u16(NAME_LEN),
  ...u16(DESC_LEN),
  ...u16(MODEL_LEN),
  ...fixedString("param log", DESC_LEN),
  ...fixedString("INS\nFMS\nCTRL", MODEL_LEN),
  0,
  1,
  ...fixedString("CONTROL", NAME_LEN),
  ...u32(1),
  ...fixedString("AIRFRAME", NAME_LEN),
  5,
  ...u32(7),
];

const airframeResult = parseMlog(new Uint8Array(bytesWithAirframeParam).buffer);
assert.equal(airframeResult.recordedInfo.airframe, 7);
assert.equal(airframeResult.recordedInfo.firmware, null);
assert.equal(airframeResult.paramGroups[0].params[0].value, 7);

const bytesWithFrameIssues = [
  ...u16(2),
  ...u32(0),
  ...u16(NAME_LEN),
  ...u16(DESC_LEN),
  ...u16(MODEL_LEN),
  ...fixedString("bad frames", DESC_LEN),
  ...fixedString("test model", MODEL_LEN),
  1,
  ...fixedString("INS_Out", NAME_LEN),
  0,
  3,
  ...fixedString("timestamp", NAME_LEN),
  ...u16(5),
  ...u16(1),
  ...fixedString("altitude", NAME_LEN),
  ...u16(6),
  ...u16(1),
  ...fixedString("speed", NAME_LEN),
  ...u16(6),
  ...u16(1),
  0,
  0x92, 0x05, 9, 1, 2, 3, 0x26,
  0x92, 0x05, 0, ...u32(1000), ...f32(1), ...f32(2), 0x00,
  ...frame(0, 1100, 2, 3),
  0x92, 0x05, 0, ...u32(1200),
];

const issueResult = parseMlog(new Uint8Array(bytesWithFrameIssues).buffer);
assert.equal(issueResult.totalFrames, 1);
assert.match(issueResult.warnings.join("\n"), /跳过/u);
assert.match(issueResult.warnings.join("\n"), /未定义消息 ID/u);
assert.match(issueResult.warnings.join("\n"), /帧尾标记不匹配/u);
assert.match(issueResult.warnings.join("\n"), /不完整数据帧/u);

console.log("smoke test passed");
