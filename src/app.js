import { clearLastLog, loadLastLog, saveLastLog } from "./logCache.js";
import { MavlinkFtpClient } from "./mavlinkFtp.js";
import { parseMlog } from "./mlogParser.js";

const languageToggle = document.querySelector("#languageToggle");
const mainTitle = document.querySelector("#mainTitle");
const flightControllerImport = document.querySelector("#flightControllerImport");
const flightControllerDialog = document.querySelector("#flightControllerDialog");
const closeFlightControllerDialog = document.querySelector("#closeFlightControllerDialog");
const connectFlightController = document.querySelector("#connectFlightController");
const refreshFlightLogList = document.querySelector("#refreshFlightLogList");
const parseSelected = document.querySelector("#parseSelected");
const downloadSelected = document.querySelector("#downloadSelected");
const flightTransfer = document.querySelector("#flightTransfer");
const flightTransferLabel = document.querySelector("#flightTransferLabel");
const flightTransferStats = document.querySelector("#flightTransferStats");
const flightTransferProgress = document.querySelector("#flightTransferProgress");
const flightSessionHint = document.querySelector("#flightSessionHint");
const baudRateSelect = document.querySelector("#baudRateSelect");
const remoteLogPath = document.querySelector("#remoteLogPath");
const flightLogList = document.querySelector("#flightLogList");
const flightControllerDialogStatus = document.querySelector("#flightControllerDialogStatus");
const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const statusText = document.querySelector("#statusText");
const fileLabel = document.querySelector("#fileLabel");
const fileName = document.querySelector("#fileName");
const clearCacheButton = document.querySelector("#clearCacheButton");
const busCount = document.querySelector("#busCount");
const frameCount = document.querySelector("#frameCount");
const metaList = document.querySelector("#metaList");
const busTable = document.querySelector("#busTable");
const paramTable = document.querySelector("#paramTable");
const chartGrid = document.querySelector("#chartGrid");

const titles = {
  zh: "FMT MLog 日志在线解析工具",
  en: "FMT MLog Online Log Parser",
};

const chartModules = [
  {
    id: "pose",
    title: "位姿信息",
    description: "飞行轨迹与位置姿态数据",
  },
  {
    id: "io",
    title: "输入输出",
    description: "任务、地面站、摇杆输入与控制输出",
  },
  {
    id: "sensors",
    title: "传感器状态",
    description: "传感器原始数据与工作状态",
  },
  {
    id: "power",
    title: "电源状态",
    description: "供电与电源消耗数据",
  },
];

const trajectoryConfig = {
  busName: "INS_Out",
  xField: "x_R",
  yField: "y_R",
  zField: "h_R",
};

let currentLanguage = "zh";
let selectedFlightControllerPort = null;
let mavlinkFtpClient = null;
let selectedFiles = new Set();
let isFlightTransferActive = false;
let transferProgressFrame = null;
let pendingTransferProgress = null;
let isDisconnectingFlightController = false;
let closeAfterParse = false;
let transferAbortController = null;

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

function updateSelectionButtons() {
  const n = selectedFiles.size;
  if (parseSelected) parseSelected.disabled = isFlightTransferActive || n !== 1;
  if (downloadSelected) {
    downloadSelected.disabled = isFlightTransferActive ? false : n === 0;
    downloadSelected.textContent = isFlightTransferActive ? "取消传输" : "下载到本地";
    downloadSelected.classList.toggle("cancel-transfer", isFlightTransferActive);
  }
}

function downloadBlobAsFile(name, arrayBuffer) {
  const blob = new Blob([arrayBuffer]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "-";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond)) {
    return "-";
  }
  if (bytesPerSecond < 1024) {
    return `${bytesPerSecond.toFixed(1)} B`;
  }
  if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB`;
  }
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB`;
}

function getRemoteFileName(path) {
  const name = path.split("/").filter(Boolean).pop();
  return name || "flight-log.bin";
}

function getSelectedRemoteFiles() {
  const rows = Array.from(flightLogList.querySelectorAll('tr[data-type="F"]'));
  return rows
    .filter((row) => selectedFiles.has(row.dataset.path))
    .map((row) => ({
      path: row.dataset.path,
      name: getRemoteFileName(row.dataset.path),
      size: Number(row.dataset.size),
    }));
}

function getKnownTotalSize(files) {
  if (!files.every((file) => Number.isFinite(file.size) && file.size >= 0)) {
    return null;
  }
  return files.reduce((sum, file) => sum + file.size, 0);
}

function joinRemotePath(directory, name) {
  return `${directory.replace(/\/$/, "")}/${name}`;
}

function resetSessionHint() {
  if (!flightSessionHint) {
    return;
  }
  flightSessionHint.hidden = true;
  flightSessionHint.textContent = "";
}

function showSessionHint(sessionId) {
  if (!flightSessionHint) {
    return;
  }
  flightSessionHint.hidden = false;
  flightSessionHint.textContent = `当前最新文件夹是 session_${sessionId}`;
}

function decodeTextFile(buffer) {
  const bytes = new Uint8Array(buffer);
  const end = bytes.indexOf(0);
  const content = new TextDecoder().decode(end >= 0 ? bytes.slice(0, end) : bytes);
  return content.trim();
}

function showTransferProgress(label, loaded = 0, total = 0, speed = 0) {
  if (!flightTransfer || !flightTransferLabel || !flightTransferStats || !flightTransferProgress) {
    return;
  }
  if (transferProgressFrame !== null) {
    cancelAnimationFrame(transferProgressFrame);
    transferProgressFrame = null;
    pendingTransferProgress = null;
  }
  flightTransfer.hidden = false;
  flightTransferLabel.textContent = label;

  if (Number.isFinite(total) && total > 0) {
    const percent = Math.min(100, Math.round((loaded / total) * 100));
    flightTransferProgress.max = 100;
    flightTransferProgress.value = percent;
    flightTransferStats.textContent = `${percent}% · ${formatBytes(loaded)} / ${formatBytes(total)} · ${formatSpeed(speed)}/s`;
  } else {
    flightTransferProgress.removeAttribute("value");
    flightTransferStats.textContent = `${formatBytes(loaded)} · ${formatSpeed(speed)}/s`;
  }
}

function showStoppedTransferProgress(label) {
  if (!flightTransfer || !flightTransferLabel || !flightTransferStats || !flightTransferProgress) {
    return;
  }
  if (transferProgressFrame !== null) {
    cancelAnimationFrame(transferProgressFrame);
    transferProgressFrame = null;
    pendingTransferProgress = null;
  }
  flightTransfer.hidden = false;
  flightTransferLabel.textContent = label;
  flightTransferProgress.max = 100;
  flightTransferProgress.value = 0;
  flightTransferStats.textContent = "0%";
}

function resetTransferProgress() {
  if (!flightTransfer || !flightTransferLabel || !flightTransferStats || !flightTransferProgress) {
    return;
  }
  if (transferProgressFrame !== null) {
    cancelAnimationFrame(transferProgressFrame);
    transferProgressFrame = null;
  }
  pendingTransferProgress = null;
  flightTransfer.hidden = true;
  flightTransferLabel.textContent = "等待传输";
  flightTransferStats.textContent = "0%";
  flightTransferProgress.max = 100;
  flightTransferProgress.value = 0;
}

async function disconnectFlightController({ updateMainStatus = true } = {}) {
  if (isDisconnectingFlightController) {
    return;
  }

  isDisconnectingFlightController = true;
  try {
    if (mavlinkFtpClient) {
      console.log("app.js: disconnecting from flight controller");
      const client = mavlinkFtpClient;
      mavlinkFtpClient = null;
      try {
        await client.close();
      } catch (error) {
        console.warn(`断开飞控连接失败：${error.message}`);
      }
    }

    if (refreshFlightLogList) refreshFlightLogList.disabled = true;
    if (connectFlightController) {
      connectFlightController.classList.remove("connected");
      connectFlightController.textContent = "连接飞控";
    }
    if (flightControllerDialogStatus) {
      flightControllerDialogStatus.textContent = "已断开连接。";
    }
    if (flightLogList) {
      flightLogList.innerHTML = '<div class="empty-state">已断开连接。</div>';
    }
    resetSessionHint();
    selectedFiles.clear();
    updateSelectionButtons();
    if (updateMainStatus) {
      setStatus("已断开连接");
    }
  } finally {
    isDisconnectingFlightController = false;
  }
}

function scheduleTransferProgress(label, loaded = 0, total = 0, speed = 0) {
  pendingTransferProgress = { label, loaded, total, speed };
  if (transferProgressFrame !== null) {
    return;
  }
  transferProgressFrame = requestAnimationFrame(() => {
    transferProgressFrame = null;
    const progress = pendingTransferProgress;
    pendingTransferProgress = null;
    if (progress) {
      showTransferProgress(progress.label, progress.loaded, progress.total, progress.speed);
    }
  });
}

function finishTransferProgress(label) {
  if (!flightTransfer || !flightTransferLabel || !flightTransferStats || !flightTransferProgress) {
    return;
  }
  flightTransfer.hidden = false;
  flightTransferLabel.textContent = label;
  flightTransferProgress.max = 100;
  flightTransferProgress.value = 100;
  flightTransferStats.textContent = "100%";
}

async function downloadRemoteFiles(files, { saveToDisk = false, parseAfterDownload = false } = {}) {
  if (!mavlinkFtpClient) {
    throw new Error("请先连接飞控。");
  }
  if (files.length === 0) {
    throw new Error("请先选择日志文件。");
  }

  const totalBytes = getKnownTotalSize(files);
  let completedBytes = 0;
  let lastProgressAt = performance.now();
  let lastProgressBytes = 0;
  let smoothedSpeed = 0;
  isFlightTransferActive = true;
  transferAbortController = new AbortController();
  if (refreshFlightLogList) refreshFlightLogList.disabled = true;
  updateSelectionButtons();

  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const labelPrefix = files.length > 1 ? `(${index + 1}/${files.length}) ` : "";
      const fileTotal = Number.isFinite(file.size) ? file.size : null;
      scheduleTransferProgress(
        `正在传输 ${labelPrefix}${file.name}`,
        completedBytes,
        totalBytes,
        smoothedSpeed,
      );
      const buffer = await mavlinkFtpClient.readFile(file.path, {
        size: fileTotal,
        signal: transferAbortController.signal,
        onProgress: ({ loaded, total }) => {
          const aggregateLoaded = completedBytes + loaded;
          const now = performance.now();
          const elapsedSeconds = Math.max(0.001, (now - lastProgressAt) / 1000);
          const deltaBytes = Math.max(0, aggregateLoaded - lastProgressBytes);
          const instantSpeed = deltaBytes / elapsedSeconds;
          smoothedSpeed = smoothedSpeed === 0 ? instantSpeed : smoothedSpeed * 0.7 + instantSpeed * 0.3;
          lastProgressAt = now;
          lastProgressBytes = aggregateLoaded;

          let displayTotal = totalBytes;
          if (!Number.isFinite(displayTotal) && files.length === 1 && Number.isFinite(total)) {
            displayTotal = total;
          }
          scheduleTransferProgress(
            `正在传输 ${labelPrefix}${file.name}`,
            aggregateLoaded,
            displayTotal,
            smoothedSpeed,
          );
        },
      });

      completedBytes += buffer.byteLength;
      lastProgressBytes = completedBytes;
      if (saveToDisk) {
        downloadBlobAsFile(file.name, buffer);
      }
      if (parseAfterDownload) {
        await parseAndRender(buffer, file.name, {
          name: file.name,
          size: buffer.byteLength,
          type: "application/octet-stream",
          lastModified: Date.now(),
        });
      }
    }
  } finally {
    isFlightTransferActive = false;
    transferAbortController = null;
    if (refreshFlightLogList) refreshFlightLogList.disabled = !mavlinkFtpClient;
    updateSelectionButtons();
  }
}

function toggleLanguage() {
  currentLanguage = currentLanguage === "zh" ? "en" : "zh";
  mainTitle.textContent = titles[currentLanguage];
  languageToggle.textContent = currentLanguage === "zh" ? "EN" : "中文";
}

function setStatus(text, kind = "") {
  statusText.textContent = text;
  statusText.className = kind;
}

function formatCacheTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function setFileDisplay(name) {
  fileName.textContent = name;
}

function setCacheState(labelText = "文件", hasCache = false) {
  fileLabel.textContent = labelText;
  clearCacheButton.hidden = !hasCache;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function formatValue(value) {
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  return String(value);
}

function formatParamValue(param) {
  if (param.value === undefined || param.value === null || param.value === "") {
    return "-";
  }
  if (param.typeName === "FLOAT" && typeof param.value === "number" && Number.isFinite(param.value)) {
    return Number(param.value.toPrecision(7)).toString();
  }
  return String(param.value);
}

function formatDurationMs(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return `${(value / 1000).toFixed(3).replace(/\.?0+$/u, "")} s`;
}

function formatElapsedSeconds(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return "-";
  }
  return formatDurationMs(Math.max(0, endMs - startMs));
}

function formatTimestampSource(source) {
  if (source === "bus_first_sample") {
    return "首个多样本消息时间戳";
  }
  if (source === "header_timestamp") {
    return "文件头 timestamp";
  }
  return "-";
}

function formatRecordedValue(value) {
  if (value === undefined || value === null || value === "") {
    return "当前日志未记录";
  }
  return String(value);
}

function formatMsValue(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return `${value} ms`;
}

function renderMeta(result) {
  const recordedInfo = result.recordedInfo ?? {};
  const modelInfoSections = Array.isArray(recordedInfo.modelInfoSections) ? recordedInfo.modelInfoSections : [];
  const modelInfoText = modelInfoSections.length
    ? modelInfoSections.join("\n")
    : result.modelInfo;
  const meta = [
    ["文件格式版本", result.version],
    ["起始时间", formatMsValue(result.timestamp)],
    ["结束时间", formatMsValue(result.maxTimestamp)],
    ["日志时长", formatElapsedSeconds(result.timestamp, result.maxTimestamp)],
    ["有效起始时间", formatMsValue(result.globalTimestampStart)],
    ["描述", result.description],
    ["模型信息", modelInfoText],
    ["机架类型", formatRecordedValue(recordedInfo.airframe)],
    ["参数组", result.paramGroups.length],
    ["解析警告", result.warnings.length ? result.warnings.join("；") : "-"],
    ["跳过字节", result.skippedBytes],
  ];

  metaList.innerHTML = meta
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(formatValue(value))}</dd></div>`)
    .join("");
}

function renderBusTable(result) {
  if (result.buses.length === 0) {
    busTable.innerHTML = '<tr><td colspan="5">未找到消息定义</td></tr>';
    return;
  }

  busTable.innerHTML = result.buses
    .map(
      (bus) => `
        <tr>
          <td>${bus.id}</td>
          <td>${escapeHtml(bus.name || "-")}</td>
          <td>${bus.elements.length}</td>
          <td>${bus.payloadSize} B</td>
          <td>${bus.frames.length}</td>
        </tr>
      `,
    )
    .join("");
}

function renderParamTable(result) {
  if (result.paramGroups.length === 0) {
    paramTable.innerHTML = '<div class="empty-state">未找到参数组</div>';
    return;
  }

  paramTable.innerHTML = result.paramGroups
    .map(
      (group) => `
        <details class="param-group">
          <summary>
            <span class="param-group-name">${escapeHtml(group.name || "-")}</span>
            <span class="param-group-count">${group.params.length} 个参数</span>
          </summary>
          <div class="param-grid" role="table" aria-label="${escapeHtml(group.name || "参数组")}">
            <div class="param-grid-head" role="row">
              <span role="columnheader">名称</span>
              <span role="columnheader">值</span>
              <span role="columnheader">类型</span>
            </div>
            ${group.params
              .map(
                (param) => `
                  <div class="param-grid-row" role="row">
                    <span role="cell">${escapeHtml(param.name || "(空名称)")}</span>
                    <span role="cell">${escapeHtml(formatParamValue(param))}</span>
                    <span role="cell">${escapeHtml(param.typeName || `TYPE_${param.type}`)}</span>
                  </div>
                `,
              )
              .join("")}
          </div>
        </details>
      `,
    )
    .join("");
}

function collectTrajectoryPoints(result) {
  const bus = result.buses.find((candidate) => candidate.name === trajectoryConfig.busName);
  if (!bus) {
    return {
      error: `没有找到 ${trajectoryConfig.busName} 消息，无法绘制航迹。`,
    };
  }

  const missingFields = [trajectoryConfig.xField, trajectoryConfig.yField, trajectoryConfig.zField].filter(
    (field) => !bus.fields.includes(field),
  );
  if (missingFields.length > 0) {
    return {
      error: `${trajectoryConfig.busName} 缺少字段：${missingFields.join("、")}。`,
    };
  }

  const timestampField = bus.timestampField && bus.fields.includes(bus.timestampField) ? bus.timestampField : null;

  const points = bus.frames
    .map((frame, index) => ({
      index,
      timeSeconds: timestampField && Number.isFinite(Number(frame[timestampField])) ? Number(frame[timestampField]) * 0.001 : index,
      x: Number(frame[trajectoryConfig.xField]),
      y: Number(frame[trajectoryConfig.yField]),
      z: Number(frame[trajectoryConfig.zField]),
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z));

  if (points.length < 2) {
    return {
      error: `${trajectoryConfig.busName}.${trajectoryConfig.xField}/${trajectoryConfig.yField}/${trajectoryConfig.zField} 有效数据点不足。`,
    };
  }

  return { points };
}

function getDefaultTrajectoryCamera() {
  return {
    eye: { x: 1.55, y: 1.65, z: 1.15 },
  };
}

function getPaddedRange(values, paddingRatio = 0.06) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      continue;
    }
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [-1, 1];
  }

  if (min === max) {
    const fallbackPadding = Math.max(1, Math.abs(min) * paddingRatio);
    return [min - fallbackPadding, max + fallbackPadding];
  }

  const padding = (max - min) * paddingRatio;
  return [min - padding, max + padding];
}

// Choose a "nice" tick step for an axis span so labels are round numbers
function niceTickStep(span, targetTicks = 12) {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / Math.max(1, targetTicks);
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const candidates = [1, 2, 5, 10];
  for (const c of candidates) {
    const step = c * base;
    if (step >= raw) return step;
  }
  return 10 * base;
}

// Attach a throttled relayout listener to keep 3D axis dtick values sensible
let _sceneTickState = { attached: false };
function setup3DAxisTickAutoscale(gd, mode) {
  if (mode !== '3d') {
    if (_sceneTickState.attached && _sceneTickState.gd === gd) {
      try { gd.removeEventListener('plotly_relayout', _sceneTickState.handler); } catch (e) {}
      _sceneTickState = { attached: false };
    }
    return;
  }
  if (_sceneTickState.attached && _sceneTickState.gd === gd) return;
  if (_sceneTickState.attached && _sceneTickState.gd && _sceneTickState.gd !== gd) {
    try { _sceneTickState.gd.removeEventListener('plotly_relayout', _sceneTickState.handler); } catch (e) {}
    _sceneTickState = { attached: false };
  }

  const handler = (relayout) => {
    // Throttle via rAF-like batching
    if (_sceneTickState.queued) return;
    _sceneTickState.queued = true;
    requestAnimationFrame(() => {
      try {
        const scene = (gd.layout && gd.layout.scene) || (gd._fullLayout && gd._fullLayout.scene);
        if (!scene) return;
        const xRange = (scene.xaxis && scene.xaxis.range) || [0, 1];
        const yRange = (scene.yaxis && scene.yaxis.range) || [0, 1];
        const zRange = (scene.zaxis && scene.zaxis.range) || [0, 1];
        const xSpan = Math.abs(xRange[1] - xRange[0]);
        const ySpan = Math.abs(yRange[1] - yRange[0]);
        const zSpan = Math.abs(zRange[1] - zRange[0]);
            const maxSpan = Math.max(xSpan, ySpan, zSpan, 1e-6);
            const base = niceTickStep(maxSpan, 12);
            // prefer a unified step, but ensure at least four ticks per axis
            const stepX = xSpan / base < 4 ? niceTickStep(xSpan, 4) : base;
            const stepY = ySpan / base < 4 ? niceTickStep(ySpan, 4) : base;
            const stepZ = zSpan / base < 4 ? niceTickStep(zSpan, 4) : base;
        const updates = {
          'scene.xaxis.dtick': stepX,
          'scene.yaxis.dtick': stepY,
          'scene.zaxis.dtick': stepZ,
        };
        window.Plotly.relayout(gd, updates).catch(() => {});
      } finally {
        _sceneTickState.queued = false;
      }
    });
  };

  gd.addEventListener('plotly_relayout', handler);
  _sceneTickState = { attached: true, gd, handler, queued: false };
}

function createTrajectoryPlotSpec(points, mode) {
  const x = points.map((point) => point.x);
  const y = points.map((point) => point.y);
  const z = points.map((point) => point.z);
  const pointMeta = points.map((point) => [point.index, point.timeSeconds]);
  const first = points[0];
  const last = points[points.length - 1];
  const commonFont = {
    family: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    color: "#172033",
  };
  const hoverlabel = {
    bgcolor: "rgba(248, 250, 252, 0.52)",
    bordercolor: "rgba(148, 163, 184, 0.28)",
    font: { color: "#172033", size: 12 },
  };
  // Small inner margins so axis titles/ticks remain visible but chart fills card
  const plotMargin = { l: 12, r: 12, t: 12, b: 12 };
  const legend = {
    x: 0.99,
    y: 0.99,
    xanchor: "right",
    yanchor: "top",
    traceorder: "normal",
    bgcolor: "rgba(248, 250, 252, 0.68)",
    bordercolor: "rgba(148, 163, 184, 0.38)",
    borderwidth: 1,
    font: { color: "#172033", size: 12 },
    itemwidth: 30,
    itemsizing: "constant",
  };

  if (mode === "2d") {
    const yAxisRange = getPaddedRange(x);
    const xAxisRange = getPaddedRange(y);

    return {
      traces: [
        {
          type: "scatter",
          mode: "lines",
          name: "二维航迹",
          x: y,
          y: x,
          customdata: pointMeta,
          line: { color: "#1d5fd1", width: 2.5 },
          hoverlabel,
          hovertemplate:
            "frame: %{customdata[0]}<br>time: %{customdata[1]:.3f} s<br>y_R: %{x:.3f} m<br>x_R: %{y:.3f} m<extra></extra>",
        },
        {
          type: "scatter",
          mode: "markers",
          name: "起点/终点",
          legendgroup: "startend",
          x: [first.y, last.y],
          y: [first.x, last.x],
          customdata: [
            [first.index, first.timeSeconds],
            [last.index, last.timeSeconds],
          ],
          marker: { color: ["#16a34a", "#dc2626"], size: 7 },
          hoverlabel,
          hovertemplate:
            "frame: %{customdata[0]}<br>time: %{customdata[1]:.3f} s<br>y_R: %{x:.3f} m<br>x_R: %{y:.3f} m<extra></extra>",
        },
        {
          type: "scatter",
          mode: "text",
          name: "起点/终点标签",
          legendgroup: "startend",
          x: [first.y, last.y],
          y: [first.x, last.x],
          text: ["起点", "终点"],
          textposition: "top center",
          showlegend: false,
          hoverinfo: "skip",
        },
      ],
      layout: {
        autosize: true,
        margin: plotMargin,
        paper_bgcolor: "#fbfcff",
        // use native pan drag mode for smoother panning (left-button)
        dragmode: "pan",
        plot_bgcolor: "#fbfcff",
        font: commonFont,
        hoverlabel,
        legend,
        xaxis: {
          title: "y_R",
          range: xAxisRange,
          gridcolor: "#dbe2ec",
          zerolinecolor: "#94a3b8",
          automargin: true,
        },
        yaxis: {
          title: "x_R",
          range: yAxisRange,
          gridcolor: "#dbe2ec",
          zerolinecolor: "#94a3b8",
          scaleanchor: "x",
          scaleratio: 1,
          automargin: true,
        },
      },
    };
  }

  // Compute ground plane extents: each side extended by 5% of the
  // maximum XY dimension so the ground is slightly larger than the trajectory.
  const finiteX = x.filter(Number.isFinite);
  const finiteY = y.filter(Number.isFinite);
  let groundXRange;
  let groundYRange;
  if (finiteX.length === 0 || finiteY.length === 0) {
    groundXRange = [-1, 1];
    groundYRange = [-1, 1];
  } else {
    const xMin = Math.min(...finiteX);
    const xMax = Math.max(...finiteX);
    const yMin = Math.min(...finiteY);
    const yMax = Math.max(...finiteY);
    let xSize = xMax - xMin;
    let ySize = yMax - yMin;
    if (!Number.isFinite(xSize) || xSize === 0) xSize = 1;
    if (!Number.isFinite(ySize) || ySize === 0) ySize = 1;
    const maxXY = Math.max(xSize, ySize);
    const groundMargin = maxXY * 0.05; // 5% of max XY size
    groundXRange = [xMin - groundMargin, xMax + groundMargin];
    groundYRange = [yMin - groundMargin, yMax + groundMargin];
  }
  // Z range keep existing padded behavior to include ground (z=0)
  const zRange = getPaddedRange([...z, 0], 0.1);

  return {
    traces: [
      {
        type: "scatter3d",
        mode: "lines",
        name: "三维航迹",
        x,
        y,
        z,
        customdata: pointMeta,
        line: { color: "#1d5fd1", width: 6 },
        hoverlabel,
        hovertemplate:
          "frame: %{customdata[0]}<br>time: %{customdata[1]:.3f} s<br>x_R: %{x:.3f} m<br>y_R: %{y:.3f} m<br>h_R: %{z:.3f} m<extra></extra>",
      },
      {
        type: "scatter3d",
        mode: "markers",
        name: "起点/终点",
        legendgroup: "startend",
        x: [first.x, last.x],
        y: [first.y, last.y],
        z: [first.z, last.z],
        customdata: [
          [first.index, first.timeSeconds],
          [last.index, last.timeSeconds],
        ],
        marker: { color: ["#16a34a", "#dc2626"], size: 7 },
        hoverlabel,
        hovertemplate:
          "frame: %{customdata[0]}<br>time: %{customdata[1]:.3f} s<br>x_R: %{x:.3f} m<br>y_R: %{y:.3f} m<br>h_R: %{z:.3f} m<extra></extra>",
      },
      {
        type: "scatter3d",
        mode: "text",
        name: "起点/终点标签",
        legendgroup: "startend",
        x: [first.x, last.x],
        y: [first.y, last.y],
        z: [first.z, last.z],
        text: ["起点", "终点"],
        textposition: "top center",
        showlegend: false,
        hoverinfo: "skip",
      },
      {
        type: "mesh3d",
        name: "地面 z=0",
        x: [groundXRange[0], groundXRange[1], groundXRange[1], groundXRange[0]],
        y: [groundYRange[0], groundYRange[0], groundYRange[1], groundYRange[1]],
        z: [0, 0, 0, 0],
        i: [0, 0],
        j: [1, 2],
        k: [2, 3],
        color: "#94a3b8",
        opacity: 0.6,
        hoverinfo: "skip",
        showlegend: true,
      },
    ],
    layout: {
      autosize: true,
      margin: plotMargin,
      paper_bgcolor: "#fbfcff",
      font: commonFont,
      hoverlabel,
      legend,
      scene: {
        // Use manual aspect where axis lengths are proportional to data ranges
        // so that 1 unit in X/Y/Z maps to the same visual length.
        aspectmode: "manual",
        aspectratio: (() => {
          // compute sizes for each axis in data units
          const finiteX = x.filter(Number.isFinite);
          const finiteY = y.filter(Number.isFinite);
          const finiteZ = z.filter(Number.isFinite);
          const xSize = finiteX.length ? Math.max(1e-6, Math.max(...finiteX) - Math.min(...finiteX)) : 1;
          const ySize = finiteY.length ? Math.max(1e-6, Math.max(...finiteY) - Math.min(...finiteY)) : 1;
          const zSize = finiteZ.length ? Math.max(1e-6, Math.max(...finiteZ) - Math.min(...finiteZ)) : 1;
          const max = Math.max(xSize, ySize, zSize);
          // normalize so largest axis gets ratio 1
          return { x: xSize / max, y: ySize / max, z: zSize / max };
        })(),
        // set initial tick spacing based on max span so X/Y/Z use consistent dtick
        xaxis: {
          title: "x_R",
          range: groundXRange,
          backgroundcolor: "#f8fafc",
          gridcolor: "#dbe2ec",
          zerolinecolor: "#94a3b8",
          dtick: (() => {
            const finiteX = x.filter(Number.isFinite);
            const finiteY = y.filter(Number.isFinite);
            const finiteZ = z.filter(Number.isFinite);
            const xSize = finiteX.length ? Math.max(1e-6, Math.max(...finiteX) - Math.min(...finiteX)) : 1;
            const ySize = finiteY.length ? Math.max(1e-6, Math.max(...finiteY) - Math.min(...finiteY)) : 1;
            const zSize = finiteZ.length ? Math.max(1e-6, Math.max(...finiteZ) - Math.min(...finiteZ)) : 1;
            const maxSpan = Math.max(xSize, ySize, zSize, 1e-6);
            const base = niceTickStep(maxSpan, 12);
            // ensure at least four ticks on this axis; if axis is much shorter, pick a smaller step
            if (xSize / base < 4) return niceTickStep(xSize, 4);
            return base;
          })(),
        },
        yaxis: {
          title: "y_R",
          range: groundYRange,
          backgroundcolor: "#f8fafc",
          gridcolor: "#dbe2ec",
          zerolinecolor: "#94a3b8",
          dtick: (() => {
            const finiteX = x.filter(Number.isFinite);
            const finiteY = y.filter(Number.isFinite);
            const finiteZ = z.filter(Number.isFinite);
            const xSize = finiteX.length ? Math.max(1e-6, Math.max(...finiteX) - Math.min(...finiteX)) : 1;
            const ySize = finiteY.length ? Math.max(1e-6, Math.max(...finiteY) - Math.min(...finiteY)) : 1;
            const zSize = finiteZ.length ? Math.max(1e-6, Math.max(...finiteZ) - Math.min(...finiteZ)) : 1;
            const maxSpan = Math.max(xSize, ySize, zSize, 1e-6);
            const base = niceTickStep(maxSpan, 12);
            if (ySize / base < 4) return niceTickStep(ySize, 4);
            return base;
          })(),
        },
        zaxis: {
          title: "h_R",
          range: zRange,
          backgroundcolor: "#f8fafc",
          gridcolor: "#dbe2ec",
          zerolinecolor: "#94a3b8",
          dtick: (() => {
            const finiteX = x.filter(Number.isFinite);
            const finiteY = y.filter(Number.isFinite);
            const finiteZ = z.filter(Number.isFinite);
            const xSize = finiteX.length ? Math.max(1e-6, Math.max(...finiteX) - Math.min(...finiteX)) : 1;
            const ySize = finiteY.length ? Math.max(1e-6, Math.max(...finiteY) - Math.min(...finiteY)) : 1;
            const zSize = finiteZ.length ? Math.max(1e-6, Math.max(...finiteZ) - Math.min(...finiteZ)) : 1;
            const maxSpan = Math.max(xSize, ySize, zSize, 1e-6);
            const base = niceTickStep(maxSpan, 12);
            if (zSize / base < 4) return niceTickStep(zSize, 4);
            return base;
          })(),
        },
        // camera: compute eye scale so plot fills more of the view for large ranges
        camera: (() => {
          const finiteX = x.filter(Number.isFinite);
          const finiteY = y.filter(Number.isFinite);
          const finiteZ = z.filter(Number.isFinite);
          const xSize = finiteX.length ? Math.max(1e-6, Math.max(...finiteX) - Math.min(...finiteX)) : 1;
          const ySize = finiteY.length ? Math.max(1e-6, Math.max(...finiteY) - Math.min(...finiteY)) : 1;
          const zSize = finiteZ.length ? Math.max(1e-6, Math.max(...finiteZ) - Math.min(...finiteZ)) : 1;
          const maxSpan = Math.max(xSize, ySize, zSize, 1e-6);
          const baseEye = getDefaultTrajectoryCamera().eye || { x: 1.55, y: 1.65, z: 1.15 };
          // Use a fixed closer factor so the plot fills the view more by default.
          const factor = 0.5;
          return { eye: { x: baseEye.x * factor, y: baseEye.y * factor, z: baseEye.z * factor } };
        })(),
      },
    },
  };
}

function renderTrajectoryPlot(points) {
  const plot = document.querySelector("#trajectoryPlot");
  const modeButton = document.querySelector('[data-chart-action="toggle-trajectory-mode"]');
  const interactionButton = document.querySelector('[data-chart-action="toggle-interaction-mode"]');
  const resetButton = document.querySelector('[data-chart-action="reset-trajectory-view"]');
  const expandButton = document.querySelector('[data-chart-action="toggle-fullscreen"]');
  const downloadButton = document.querySelector('[data-chart-action="download-trajectory-image"]');
  const downloadCsvButton = document.querySelector('[data-chart-action="download-trajectory-csv"]');
  const subtitle = document.querySelector("#trajectorySubtitle");
  if (!plot) {
    return;
  }

  if (!window.Plotly) {
    plot.innerHTML = '<div class="chart-module-empty">Plotly.js 加载失败，无法显示航迹图。</div>';
    return;
  }

  let mode = "3d";
  let interactionMode = "pan"; // or 'zoom'

  const draw = () => {
    const spec = createTrajectoryPlotSpec(points, mode);
    // enable native scrollZoom only for 3D; for 2D we use the controlled handler
    const config = {
      displayModeBar: false,
      displaylogo: false,
      responsive: true,
      scrollZoom: mode === '3d',
    };
    window.Plotly.purge(plot);
    window.Plotly.newPlot(plot, spec.traces, spec.layout, config);
    // set dragmode according to interactionMode for 2D plots
    if (mode === '2d') {
      try { window.Plotly.relayout(plot, { dragmode: interactionMode === 'pan' ? 'pan' : 'zoom' }); } catch (e) {}
    }
    // attach controlled wheel zoom for 2D mode (and remove when switching to 3D)
    setupWheelZoom(plot, mode);
    // attach 3D axis tick autoscale when in 3D (and remove when switching to 2D)
    setup3DAxisTickAutoscale(plot, mode);
    // set button icons from assets/icons
    const iconPath = (name) => `assets/icons/${name}.svg`;
    if (modeButton) {
      // show the target mode on the button: when currently 3D, show 2D icon (meaning 'switch to 2D')
      const name = mode === '3d' ? '2d' : '3d';
      modeButton.innerHTML = `<img src="${iconPath(name)}" alt="${name}">`;
      modeButton.title = mode === '3d' ? '切换二维' : '切换三维';
    }
    if (interactionButton) {
      // show the target interaction: when currently 'pan', show 'zoom' icon (meaning 'switch to zoom')
      const name = interactionMode === 'pan' ? 'zoom' : 'pan';
      interactionButton.innerHTML = `<img src="${iconPath(name)}" alt="${name}">`;
      interactionButton.title = interactionMode === 'pan' ? '切换到缩放' : '切换到平移';
    }
    if (resetButton) {
      resetButton.innerHTML = `<img src="${iconPath('reset')}" alt="reset">`;
      resetButton.title = '复位视图';
    }
    if (expandButton) {
      expandButton.innerHTML = `<img src="${iconPath('full')}" alt="full">`;
      expandButton.title = '展开图片';
    }
    if (downloadButton) {
      downloadButton.innerHTML = `<img src="${iconPath('download')}" alt="download">`;
      downloadButton.title = '下载图片';
    }
    if (downloadCsvButton) {
      downloadCsvButton.innerHTML = `<img src="${iconPath('csv')}" alt="csv">`;
      downloadCsvButton.title = '下载数据 CSV';
    }
    if (subtitle) {
      subtitle.textContent =
        mode === "3d"
          ? `三维航迹 · INS_Out.x_R / y_R / h_R · ${points.length} 点`
          : `二维航迹 · INS_Out.x_R / y_R · ${points.length} 点`;
    }
  };

  // Use Plotly's native interactions for panning/zooming to keep smooth performance.

  modeButton?.addEventListener("click", () => {
    mode = mode === "3d" ? "2d" : "3d";
    draw();
  });

  interactionButton?.addEventListener("click", () => {
    // Toggle interaction mode without redrawing the whole plot (preserve view)
    interactionMode = interactionMode === 'pan' ? 'zoom' : 'pan';
    // If currently in 2D, apply dragmode immediately so view is not reset
    if (mode === '2d') {
      try {
        window.Plotly.relayout(plot, { dragmode: interactionMode === 'pan' ? 'pan' : 'zoom' });
      } catch (e) {
        // ignore
      }
    }
    // Update the interaction button icon/title in-place (show target mode)
    try {
      const iconPath = (name) => `assets/icons/${name}.svg`;
      const name = interactionMode === 'pan' ? 'zoom' : 'pan';
      if (interactionButton) {
        interactionButton.innerHTML = `<img src="${iconPath(name)}" alt="${name}">`;
        interactionButton.title = interactionMode === 'pan' ? '切换到缩放' : '切换到平移';
      }
    } catch (e) {}
  });

  resetButton?.addEventListener("click", () => {
    draw();
  });

  expandButton?.addEventListener('click', () => {
    const container = plot.parentElement;
    if (!container) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(()=>{});
      return;
    }
    if (container.requestFullscreen) {
      container.requestFullscreen().catch(()=>{});
    } else if (container.webkitRequestFullscreen) {
      container.webkitRequestFullscreen();
    }
  });

  downloadButton?.addEventListener("click", () => {
    window.Plotly.downloadImage(plot, {
      format: "png",
      filename: mode === "3d" ? "INS_Out_trajectory_3d" : "INS_Out_trajectory_xy",
      width: 1400,
      height: 900,
    });
  });

  downloadCsvButton?.addEventListener('click', () => {
    try {
      const header = ['index','timeSeconds','x','y','z'];
      const rows = points.map(p => [p.index, p.timeSeconds, p.x, p.y, p.z]);
      const csv = [header.join(','), ...rows.map(r => r.join(','))].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = mode === '3d' ? 'INS_Out_trajectory_3d.csv' : 'INS_Out_trajectory_xy.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.warn('导出 CSV 失败', e);
    }
  });

  draw();
}

// Controlled wheel zoom for 2D plots: throttled, centered at cursor, uses Plotly.relayout
let _wheelZoomState = { attached: false };
function setupWheelZoom(gd, currentMode) {
  // If not in 2D mode, remove any existing handler for this graph and return
  if (currentMode !== '2d') {
    if (_wheelZoomState.attached && _wheelZoomState.gd === gd) {
      try {
        _wheelZoomState.gd.removeEventListener('wheel', _wheelZoomState.handler, { passive: false });
      } catch (err) {
        // ignore
      }
      _wheelZoomState = { attached: false };
    }
    return;
  }

  // If already attached to this graph, do nothing
  if (_wheelZoomState.attached && _wheelZoomState.gd === gd) return;

  // If attached to a different graph, remove it first
  if (_wheelZoomState.attached && _wheelZoomState.gd && _wheelZoomState.gd !== gd) {
    try {
      _wheelZoomState.gd.removeEventListener('wheel', _wheelZoomState.handler, { passive: false });
    } catch (err) {}
    _wheelZoomState = { attached: false };
  }

  // attach
  const handler = (ev) => {
    if (ev.ctrlKey || ev.metaKey) return; // allow browser zoom with ctrl/meta
    ev.preventDefault();
    const full = gd._fullLayout;
    if (!full || !full.xaxis || !full.yaxis) return;
    const xaxis = full.xaxis;
    const yaxis = full.yaxis;
    const bbox = gd.getBoundingClientRect();
    const px = ev.clientX - bbox.left;
    const py = ev.clientY - bbox.top;
    const xOffset = xaxis._offset || 0;
    const yOffset = yaxis._offset || 0;
    const xLen = xaxis._length || (bbox.width - xOffset) || 1;
    const yLen = yaxis._length || (bbox.height - yOffset) || 1;
    const xStart = xaxis.range[0];
    const xEnd = xaxis.range[1];
    const yStart = yaxis.range[0];
    const yEnd = yaxis.range[1];
    const rx = (px - xOffset) / xLen;
    const ry = 1 - (py - yOffset) / yLen;
    const cx = Math.max(0, Math.min(1, rx));
    const cy = Math.max(0, Math.min(1, ry));
    const delta = ev.deltaY;
    const factor = Math.exp(delta * -0.0025);
    const newXSpan = (xEnd - xStart) * factor;
    const newYSpan = (yEnd - yStart) * factor;
    const xCenter = xStart + cx * (xEnd - xStart);
    const yCenter = yStart + cy * (yEnd - yStart);
    const newX = [xCenter - cx * newXSpan, xCenter + (1 - cx) * newXSpan];
    const newY = [yCenter - cy * newYSpan, yCenter + (1 - cy) * newYSpan];
    if (_wheelZoomState.queued) {
      _wheelZoomState.queued = { newX, newY };
      return;
    }
    _wheelZoomState.queued = { newX, newY };
    requestAnimationFrame(() => {
      const q = _wheelZoomState.queued;
      if (q) {
        window.Plotly.relayout(gd, { 'xaxis.range': q.newX, 'yaxis.range': q.newY });
      }
      _wheelZoomState.queued = null;
    });
  };
  gd.addEventListener('wheel', handler, { passive: false });
  _wheelZoomState = { attached: true, gd, handler, queued: null };
}

function renderTrajectoryFigure(trajectory) {
  if (trajectory.error) {
    return `<div class="chart-module-empty">${escapeHtml(trajectory.error)}</div>`;
  }

  return `
    <article class="chart-figure">
      <div class="chart-figure-main">
        <div class="chart-title">
          <span>航迹</span>
          <small id="trajectorySubtitle">三维航迹 · INS_Out.x_R / y_R / h_R · ${trajectory.points.length} 点</small>
        </div>
        <div class="plotly-chart" id="trajectoryPlot" aria-label="INS_Out 可切换二维三维航迹图"></div>
      </div>
      <div class="chart-actions" aria-label="航迹图操作">
        <button class="icon-button" type="button" data-chart-action="toggle-trajectory-mode" aria-label="切换 2D/3D"></button>
        <button class="icon-button" type="button" data-chart-action="toggle-interaction-mode" aria-label="切换 平移/缩放"></button>
        <button class="icon-button" type="button" data-chart-action="reset-trajectory-view" aria-label="复位视图"></button>
        <button class="icon-button" type="button" data-chart-action="toggle-fullscreen" aria-label="展开"></button>
        <button class="icon-button" type="button" data-chart-action="download-trajectory-image" aria-label="下载图片"></button>
        <button class="icon-button" type="button" data-chart-action="download-trajectory-csv" aria-label="下载 CSV"></button>
      </div>
    </article>
  `;
}

function renderModuleContent(module, trajectory) {
  if (module.id === "pose") {
    return renderTrajectoryFigure(trajectory);
  }

  return '<div class="chart-module-empty">图表待添加</div>';
}

function renderCharts(result) {
  const trajectory = collectTrajectoryPoints(result);

  chartGrid.innerHTML = chartModules
    .map(
      (module) => `
        <section class="chart-module" aria-label="${escapeHtml(module.title)}">
          <div class="chart-module-header">
            <div>
              <h3>${escapeHtml(module.title)}</h3>
              <p>${escapeHtml(module.description)}</p>
            </div>
          </div>
          <div class="chart-stack">
            ${renderModuleContent(module, trajectory)}
          </div>
        </section>
      `,
    )
    .join("");

  if (!trajectory.error) {
    requestAnimationFrame(() => {
      renderTrajectoryPlot(trajectory.points);
    });
  }
}

async function parseAndRender(buffer, displayName, cacheMeta = null) {
  setFileDisplay(displayName);
  setCacheState("文件", false);
  busCount.textContent = "-";
  frameCount.textContent = "-";
  setStatus("解析中");

  try {
    const result = parseMlog(buffer);
    let hasCache = false;
    let cacheText = "";

    if (cacheMeta) {
      try {
        await saveLastLog({
          ...cacheMeta,
          buffer,
        });
        hasCache = true;
        cacheText = `文件（已缓存 ${formatCacheTime(Date.now())}）`;
      } catch (error) {
        result.warnings.push(`日志缓存失败：${error.message}`);
      }
    }

    busCount.textContent = result.buses.length;
    frameCount.textContent = result.totalFrames;
    setStatus(cacheMeta ? "解析完成，已缓存" : "已从缓存恢复", "ok");
    setCacheState(cacheText, hasCache);

    renderMeta(result);
    renderBusTable(result);
    renderParamTable(result);
    renderCharts(result);
  } catch (error) {
    setStatus("解析失败", "error");
    chartGrid.innerHTML = `<div class="empty-state">解析失败：${escapeHtml(error.message)}</div>`;
  }
}

async function handleFile(file) {
  const buffer = await file.arrayBuffer();
  await parseAndRender(buffer, file.name, {
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  });
}

async function restoreCachedLog() {
  try {
    const cached = await loadLastLog();
    if (!cached) {
      setCacheState("文件", false);
      return;
    }

    const savedTime = cached.savedAt ? formatCacheTime(cached.savedAt) : "";
    await parseAndRender(cached.buffer, cached.name);
    setCacheState(savedTime ? `文件（缓存自 ${savedTime}）` : "文件（缓存）", true);
  } catch (error) {
    setStatus(`读取缓存失败：${error.message}`, "error");
  }
}

clearCacheButton.addEventListener("click", async () => {
  try {
    await clearLastLog();
    setCacheState("文件", false);
    setStatus("缓存已清除");
  } catch (error) {
    setStatus(`清除缓存失败：${error.message}`, "error");
  }
});

fileInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) {
    handleFile(file);
  }
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("drag-over");
  const [file] = event.dataTransfer.files;
  if (file) {
    handleFile(file);
  }
});

languageToggle.addEventListener("click", toggleLanguage);

flightControllerImport.addEventListener("click", async () => {
  if (!("serial" in navigator)) {
    setStatus("当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge", "error");
    return;
  }

  try {
    selectedFlightControllerPort = await navigator.serial.requestPort();
    resetTransferProgress();
    resetSessionHint();
    flightControllerDialogStatus.textContent = "串口已授权，等待连接。";
    flightLogList.innerHTML = '<div class="empty-state">点击“连接飞控”后，将通过 MAVLink FTP 读取日志目录。</div>';
    refreshFlightLogList.disabled = true;
    flightControllerDialog.showModal();
    setStatus("已选择飞控串口", "ok");
  } catch (error) {
    if (error.name !== "NotFoundError") {
      setStatus(`选择串口失败：${error.message}`, "error");
    }
  }
});

closeFlightControllerDialog.addEventListener("click", () => {
  flightControllerDialog.close();
});

flightControllerDialog.addEventListener("close", () => {
  const keepMainStatus = closeAfterParse;
  closeAfterParse = false;
  void disconnectFlightController({ updateMainStatus: !keepMainStatus });
});

connectFlightController.addEventListener("click", async () => {
  if (!selectedFlightControllerPort) {
    flightControllerDialogStatus.textContent = "请先选择飞控串口。";
    return;
  }

  try {
    // If already connected, treat as a disconnect request
    if (mavlinkFtpClient) {
      await disconnectFlightController();
      return;
    }

    console.log('app.js: connectFlightController clicked - starting open');
    mavlinkFtpClient = new MavlinkFtpClient(selectedFlightControllerPort);
    // Use the client's internal open with a timeout to avoid UI hang if driver stalls
    await mavlinkFtpClient.open(Number(baudRateSelect.value));
    console.log('app.js: mavlinkFtpClient.open returned');
    refreshFlightLogList.disabled = false;
    connectFlightController.classList.add("connected");
    connectFlightController.textContent = "断开连接";
    flightControllerDialogStatus.textContent = `串口已连接，日志路径：${remoteLogPath.value}`;
    flightLogList.innerHTML = '<div class="empty-state">点击“刷新文件列表”读取飞控日志目录。</div>';
    setStatus("飞控已连接", "ok");
  } catch (error) {
    flightControllerDialogStatus.textContent = `连接失败：${error.message}`;
  }
});

refreshFlightLogList.addEventListener("click", async () => {
  if (!mavlinkFtpClient) {
    flightControllerDialogStatus.textContent = "请先连接飞控。";
    return;
  }

  refreshFlightLogList.disabled = true;
  flightControllerDialogStatus.textContent = `正在读取目录：${remoteLogPath.value}`;
  flightLogList.innerHTML = '<div class="empty-state">正在读取文件列表...</div>';
  resetTransferProgress();
  resetSessionHint();

  try {
    // recursive fetch
    selectedFiles.clear();
    updateSelectionButtons();
    const rootPath = (remoteLogPath.value || "/log/").trim();
    const normalizedRootPath = rootPath.endsWith("/") ? rootPath : rootPath + "/";
    const rootList = await mavlinkFtpClient.listDirectory(normalizedRootPath);
    const sessionEntry = rootList.find((entry) => entry.type === "F" && entry.name === "session_id");
    let sessionLabel = "";

    if (sessionEntry) {
      const sessionPath = joinRemotePath(normalizedRootPath, sessionEntry.name);
      try {
        const sessionBuffer = await mavlinkFtpClient.readFile(sessionPath, { size: sessionEntry.size });
        const sessionId = decodeTextFile(sessionBuffer);
        if (sessionId) {
          sessionLabel = `，当前最新文件夹是 session_${sessionId}`;
          showSessionHint(sessionId);
        }
      } catch (error) {
        sessionLabel = `，读取 session_id 失败：${error.message}`;
      }
    }

    async function fetchRecursive(path, knownList = null) {
      const list = knownList ?? await mavlinkFtpClient.listDirectory(path);
      const nodes = [];
      for (const entry of list) {
        const name = entry.name;
        const fullPath = joinRemotePath(path, name);
        if (entry.type === "D") {
          const children = await fetchRecursive(fullPath + "/");
          nodes.push({ type: "D", name, path: fullPath + "/", children });
        } else {
          nodes.push({ type: "F", name, path: fullPath, size: entry.size });
        }
      }
      return nodes;
    }

    const tree = await fetchRecursive(normalizedRootPath, rootList);

    // render as compact table with collapsible directories
    function renderTable(treeNodes, container) {
      const table = document.createElement('table');
      table.className = 'flight-log-table';
      const thead = document.createElement('thead');
      thead.innerHTML = `<tr><th style="width:80px">类型</th><th class="name-header">名称</th><th style="width:120px">大小</th></tr>`;
      const tbody = document.createElement('tbody');

      let idCounter = 1;
      const childrenMap = new Map();

      function getRow(id) {
        return tbody.querySelector(`tr[data-id="${id}"]`);
      }

      function getAllDescendants(parentId) {
        const out = [];
        const stack = [...(childrenMap.get(parentId) || [])];
        while (stack.length) {
          const childId = stack.shift();
          out.push(childId);
          const grandchildren = childrenMap.get(childId);
          if (grandchildren && grandchildren.length) stack.push(...grandchildren);
        }
        return out;
      }

      function setFileSelected(row, isSelected) {
        const toggle = row.querySelector('.file-toggle');
        if (!toggle) return;
        toggle.setAttribute('aria-checked', isSelected ? 'true' : 'false');
        toggle.classList.toggle('checked', isSelected);
        if (isSelected) {
          selectedFiles.add(row.dataset.path);
        } else {
          selectedFiles.delete(row.dataset.path);
        }
      }

      function setDirectorySelected(row, isSelected, state = isSelected ? '2' : '0') {
        const toggle = row.querySelector('.dir-toggle');
        if (!toggle) return;
        toggle.dataset.state = state;
        toggle.setAttribute('aria-checked', isSelected ? 'true' : 'false');
        toggle.classList.toggle('checked', isSelected);
        toggle.classList.remove('indeterminate');
      }

      function setDescendantsSelected(parentId, isSelected) {
        for (const childId of getAllDescendants(parentId)) {
          const row = getRow(childId);
          if (!row) continue;
          if (row.dataset.type === 'F') {
            setFileSelected(row, isSelected);
          } else {
            setDirectorySelected(row, isSelected, isSelected ? '2' : '0');
          }
        }
      }

      function addRows(nodes, depth = 0, parentId = '') {
        for (const node of nodes) {
          const id = `n${idCounter++}`;
          if (parentId) {
            const arr = childrenMap.get(parentId) || [];
            arr.push(id);
            childrenMap.set(parentId, arr);
          }

          const tr = document.createElement('tr');
          tr.dataset.id = id;
          if (parentId) tr.dataset.parent = parentId;
          tr.dataset.type = node.type;
          tr.dataset.path = node.path;
          if (node.type === 'F' && Number.isFinite(node.size)) {
            tr.dataset.size = String(node.size);
          }

          const tdType = document.createElement('td');
          tdType.textContent = node.type === 'D' ? '目录' : '文件';

          const tdName = document.createElement('td');
          tdName.className = 'name-cell';
          tdName.style.paddingLeft = `${24 + depth * 16}px`;

          if (node.type === 'D') {
            // Directory control: three-state cycle
            // 0 = collapsed/unchecked, 1 = expanded (unchecked), 2 = checked (select all descendants)
            // Use a JS-controlled non-form element to avoid browser native checkbox timing races
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'dir-toggle';
            toggle.setAttribute('role', 'checkbox');
            toggle.setAttribute('aria-checked', 'false');
            toggle.dataset.state = '0';

            toggle.addEventListener('click', (e) => {
              e.stopPropagation();
              const state = Number(toggle.dataset.state || '0');
              if (state === 0) {
                // First click: expand only.
                setDirectorySelected(tr, false, '1');
                showChildren(id);
              } else if (state === 1) {
                // Second click: select this directory control and every descendant file.
                setDescendantsSelected(id, true);
                setDirectorySelected(tr, true, '2');
                updateSelectionButtons();
              } else {
                // Third click: collapse and clear every descendant selection.
                setDescendantsSelected(id, false);
                setDirectorySelected(tr, false, '0');
                hideDescendants(id);
                updateSelectionButtons();
              }
            });

            const label = document.createElement('span');
            label.textContent = node.name;
            tdName.append(toggle, label);
          } else {
            // File control: use a button sized like dir-toggle to avoid native checkbox races
            const cb = document.createElement('button');
            cb.type = 'button';
            cb.className = 'file-toggle';
            cb.setAttribute('role', 'checkbox');
            cb.setAttribute('aria-checked', 'false');
            cb.addEventListener('click', (ev) => {
              ev.stopPropagation();
              const checked = cb.getAttribute('aria-checked') === 'true';
              setFileSelected(tr, !checked);
              updateSelectionButtons();
            });
            const label = document.createElement('span');
            label.textContent = node.name;
            tdName.append(cb, label);
          }

          const tdSize = document.createElement('td');
          tdSize.textContent = node.type === 'D' ? '-' : (Number.isFinite(node.size) ? `${node.size} B` : '-');

          tr.append(tdType, tdName, tdSize);
          tbody.appendChild(tr);

          if (node.type === 'D') {
            childrenMap.set(id, []);
            addRows(node.children, depth + 1, id);
          }
        }
      }

      function showChildren(parentId) {
        const children = childrenMap.get(parentId) || [];
        for (const cid of children) {
          const row = getRow(cid);
          if (row) row.style.display = '';
        }
      }

      function hideDescendants(parentId) {
        const children = childrenMap.get(parentId) || [];
        for (const cid of children) {
          const row = getRow(cid);
          if (row) {
            row.style.display = 'none';
            if (childrenMap.has(cid)) hideDescendants(cid);
            if (row.dataset.type === 'D') setDirectorySelected(row, false, '0');
          }
        }
      }

      addRows(treeNodes, 0, '');

      table.appendChild(thead);
      table.appendChild(tbody);
      container.innerHTML = '';
      container.appendChild(table);

      tbody.querySelectorAll('tr[data-parent]').forEach((r) => (r.style.display = 'none'));
    }

    renderTable(tree, flightLogList);
    flightControllerDialogStatus.textContent = `已读取并构建目录树${sessionLabel}`;
  } catch (error) {
    flightLogList.innerHTML = `<div class="empty-state">读取失败：${escapeHtml(error.message)}</div>`;
    flightControllerDialogStatus.textContent = `读取目录失败：${error.message}`;
  } finally {
    refreshFlightLogList.disabled = false;
  }
});

restoreCachedLog();

// Flight-controller file transfer button handlers.
if (parseSelected) {
  parseSelected.addEventListener('click', async () => {
    if (selectedFiles.size !== 1 || isFlightTransferActive) return;
    const files = getSelectedRemoteFiles();
    if (files.length !== 1) return;
    try {
      setStatus(`正在从飞控读取 ${files[0].name}`);
      await downloadRemoteFiles(files, { parseAfterDownload: true });
      finishTransferProgress(`已读取并解析 ${files[0].name}`);
      closeAfterParse = true;
      flightControllerDialog.close();
    } catch (error) {
      if (isAbortError(error)) {
        showStoppedTransferProgress("传输已取消");
        setStatus("读取飞控日志已取消");
        return;
      }
      showTransferProgress(`传输失败：${error.message}`);
      setStatus(`读取飞控日志失败：${error.message}`, "error");
    }
  });
}

if (downloadSelected) {
  downloadSelected.addEventListener('click', async () => {
    if (isFlightTransferActive) {
      transferAbortController?.abort(makeAbortError());
      showStoppedTransferProgress("正在取消传输...");
      return;
    }
    if (selectedFiles.size === 0 || isFlightTransferActive) return;
    const files = getSelectedRemoteFiles();
    try {
      setStatus(`正在下载 ${files.length} 个飞控日志文件`);
      await downloadRemoteFiles(files, { saveToDisk: true });
      finishTransferProgress(`已下载 ${files.length} 个文件`);
      setStatus(`已下载 ${files.length} 个飞控日志文件`, "ok");
    } catch (error) {
      if (isAbortError(error)) {
        showStoppedTransferProgress("传输已取消");
        setStatus("下载飞控日志已取消");
        return;
      }
      showTransferProgress(`传输失败：${error.message}`);
      setStatus(`下载飞控日志失败：${error.message}`, "error");
    }
  });
}
