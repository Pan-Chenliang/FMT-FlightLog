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
assert.equal(result.totalFrames, 3);
assert.equal(result.buses[0].frames[1].delta_ts, 20);

const series = collectChartSeries(result, 6);
assert.equal(series.length, 2);
assert.equal(series[0].field, "altitude");

console.log("smoke test passed");
