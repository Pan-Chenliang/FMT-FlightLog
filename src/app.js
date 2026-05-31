import { clearLastLog, loadLastLog, saveLastLog } from "./logCache.js";
import { MavlinkFtpClient } from "./mavlinkFtp.js";
import { busToCsv, collectChartSeries, parseMlog } from "./mlogParser.js";

const languageToggle = document.querySelector("#languageToggle");
const mainTitle = document.querySelector("#mainTitle");
const flightControllerImport = document.querySelector("#flightControllerImport");
const flightControllerDialog = document.querySelector("#flightControllerDialog");
const closeFlightControllerDialog = document.querySelector("#closeFlightControllerDialog");
const connectFlightController = document.querySelector("#connectFlightController");
const refreshFlightLogList = document.querySelector("#refreshFlightLogList");
const baudRateSelect = document.querySelector("#baudRateSelect");
const remoteLogPath = document.querySelector("#remoteLogPath");
const flightLogList = document.querySelector("#flightLogList");
const flightControllerDialogStatus = document.querySelector("#flightControllerDialogStatus");
const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const statusText = document.querySelector("#statusText");
const fileName = document.querySelector("#fileName");
const busCount = document.querySelector("#busCount");
const frameCount = document.querySelector("#frameCount");
const metaList = document.querySelector("#metaList");
const busTable = document.querySelector("#busTable");
const paramTable = document.querySelector("#paramTable");
const chartGrid = document.querySelector("#chartGrid");
const downloadActions = document.querySelector("#downloadActions");

const titles = {
  zh: "FMT MLog 日志在线解析工具",
  en: "FMT MLog Online Log Parser",
};

let currentLanguage = "zh";
let selectedFlightControllerPort = null;
let mavlinkFtpClient = null;

function toggleLanguage() {
  currentLanguage = currentLanguage === "zh" ? "en" : "zh";
  mainTitle.textContent = titles[currentLanguage];
  languageToggle.textContent = currentLanguage === "zh" ? "EN" : "中文";
}

function setStatus(text, kind = "") {
  statusText.textContent = text;
  statusText.className = kind;
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

function renderMeta(result) {
  const meta = [
    ["版本", result.version],
    ["时间戳", result.timestamp],
    ["描述", result.description],
    ["模型信息", result.modelInfo],
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
    paramTable.innerHTML = '<tr><td colspan="3">未找到参数组</td></tr>';
    return;
  }

  paramTable.innerHTML = result.paramGroups
    .map((group) => {
      const examples = group.params
        .slice(0, 5)
        .map((param) => `${param.name || "(空名称)"}=${formatValue(param.value)} (${param.typeName})`)
        .join("，");

      return `
        <tr>
          <td>${escapeHtml(group.name || "-")}</td>
          <td>${group.params.length}</td>
          <td>${escapeHtml(examples || "-")}</td>
        </tr>
      `;
    })
    .join("");
}

function niceNumber(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  const abs = Math.abs(value);
  if (abs >= 1000 || (abs > 0 && abs < 0.01)) {
    return value.toExponential(2);
  }
  return value.toFixed(3).replace(/\.?0+$/u, "");
}

function drawSeries(canvas, series) {
  const pixelRatio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width * pixelRatio));
  const height = Math.max(220, Math.floor(rect.height * pixelRatio));
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  const pad = {
    left: 56 * pixelRatio,
    right: 18 * pixelRatio,
    top: 18 * pixelRatio,
    bottom: 42 * pixelRatio,
  };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  const xs = series.points.map((point) => point.x);
  const ys = series.points.map((point) => point.y);
  let xMin = Math.min(...xs);
  let xMax = Math.max(...xs);
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);

  if (xMin === xMax) {
    xMin -= 1;
    xMax += 1;
  }
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }

  const xScale = (value) => pad.left + ((value - xMin) / (xMax - xMin)) * plotWidth;
  const yScale = (value) => pad.top + plotHeight - ((value - yMin) / (yMax - yMin)) * plotHeight;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fbfcff";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#dbe2ec";
  ctx.lineWidth = 1 * pixelRatio;
  ctx.font = `${12 * pixelRatio}px sans-serif`;
  ctx.fillStyle = "#657084";

  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (plotHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();

    const value = yMax - ((yMax - yMin) / 4) * i;
    ctx.fillText(niceNumber(value), 8 * pixelRatio, y + 4 * pixelRatio);
  }

  for (let i = 0; i <= 4; i += 1) {
    const x = pad.left + (plotWidth / 4) * i;
    const value = xMin + ((xMax - xMin) / 4) * i;
    ctx.fillText(niceNumber(value), x - 18 * pixelRatio, height - 15 * pixelRatio);
  }

  ctx.strokeStyle = "#1d5fd1";
  ctx.lineWidth = 2 * pixelRatio;
  ctx.beginPath();
  series.points.forEach((point, index) => {
    const x = xScale(point.x);
    const y = yScale(point.y);
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  ctx.fillStyle = "#174aa1";
  const step = Math.max(1, Math.floor(series.points.length / 180));
  for (let i = 0; i < series.points.length; i += step) {
    const point = series.points[i];
    ctx.beginPath();
    ctx.arc(xScale(point.x), yScale(point.y), 2.2 * pixelRatio, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderCharts(result) {
  const seriesList = collectChartSeries(result, 6);
  if (seriesList.length === 0) {
    chartGrid.innerHTML = '<div class="empty-state">没有找到可绘制的变化数值字段。</div>';
    return;
  }

  chartGrid.innerHTML = seriesList
    .map(
      (series, index) => `
        <div class="chart-card">
          <div class="chart-title">
            <span>${escapeHtml(series.busName)}.${escapeHtml(series.field)}</span>
            <small>x: ${escapeHtml(series.xLabel)}</small>
          </div>
          <canvas id="chart-${index}" height="260"></canvas>
        </div>
      `,
    )
    .join("");

  requestAnimationFrame(() => {
    seriesList.forEach((series, index) => {
      drawSeries(document.querySelector(`#chart-${index}`), series);
    });
  });
}

function downloadText(filename, text, mimeType) {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function renderDownloads(result) {
  const busesWithFrames = result.buses.filter((bus) => bus.frames.length > 0);
  downloadActions.innerHTML = "";

  const reportButton = document.createElement("button");
  reportButton.type = "button";
  reportButton.textContent = "下载摘要 JSON";
  reportButton.addEventListener("click", () => {
    const summary = {
      version: result.version,
      timestamp: result.timestamp,
      description: result.description,
      modelInfo: result.modelInfo,
      buses: result.buses.map((bus) => ({
        id: bus.id,
        name: bus.name,
        fields: bus.fields,
        payloadSize: bus.payloadSize,
        frames: bus.frames.length,
      })),
      paramGroups: result.paramGroups,
    };
    downloadText("mlog-summary.json", JSON.stringify(summary, null, 2), "application/json");
  });
  downloadActions.append(reportButton);

  for (const bus of busesWithFrames.slice(0, 4)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `CSV ${bus.name || bus.id}`;
    button.addEventListener("click", () => {
      downloadText(`mlog_msg_${bus.id}_${bus.name || "bus"}.csv`, busToCsv(bus), "text/csv");
    });
    downloadActions.append(button);
  }

  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.textContent = "清除缓存";
  clearButton.addEventListener("click", async () => {
    try {
      await clearLastLog();
      setStatus("缓存已清除");
    } catch (error) {
      setStatus(`清除缓存失败：${error.message}`, "error");
    }
  });
  downloadActions.append(clearButton);
}

async function parseAndRender(buffer, displayName, cacheMeta = null) {
  fileName.textContent = displayName;
  busCount.textContent = "-";
  frameCount.textContent = "-";
  setStatus("解析中");

  try {
    const result = parseMlog(buffer);

    if (cacheMeta) {
      try {
        await saveLastLog({
          ...cacheMeta,
          buffer,
        });
      } catch (error) {
        result.warnings.push(`日志缓存失败：${error.message}`);
      }
    }

    busCount.textContent = result.buses.length;
    frameCount.textContent = result.totalFrames;
    setStatus(cacheMeta ? "解析完成，已缓存" : "已从缓存恢复", "ok");

    renderMeta(result);
    renderBusTable(result);
    renderParamTable(result);
    renderCharts(result);
    renderDownloads(result);
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
      return;
    }

    const savedTime = cached.savedAt ? new Date(cached.savedAt).toLocaleString() : "";
    const suffix = savedTime ? `（缓存：${savedTime}）` : "（缓存）";
    await parseAndRender(cached.buffer, `${cached.name}${suffix}`);
  } catch (error) {
    setStatus(`读取缓存失败：${error.message}`, "error");
  }
}

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

connectFlightController.addEventListener("click", async () => {
  if (!selectedFlightControllerPort) {
    flightControllerDialogStatus.textContent = "请先选择飞控串口。";
    return;
  }

  try {
    // If already connected, treat as a disconnect request
    if (mavlinkFtpClient) {
      console.log("app.js: disconnecting from flight controller");
      await mavlinkFtpClient.close();
      mavlinkFtpClient = null;
      refreshFlightLogList.disabled = true;
      connectFlightController.classList.remove("connected");
      connectFlightController.textContent = "连接飞控";
      flightControllerDialogStatus.textContent = "已断开连接。";
      flightLogList.innerHTML = '<div class="empty-state">已断开连接。</div>';
      setStatus("已断开连接");
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

  try {
    const entries = await mavlinkFtpClient.listDirectory(remoteLogPath.value.trim() || "/log/");
    if (entries.length === 0) {
      flightLogList.innerHTML = '<div class="empty-state">该目录没有返回文件。</div>';
    } else {
      flightLogList.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>类型</th>
              <th>名称</th>
              <th>大小</th>
            </tr>
          </thead>
          <tbody>
            ${entries
              .map(
                (entry) => `
                  <tr>
                    <td>${entry.type === "D" ? "目录" : "文件"}</td>
                    <td>${escapeHtml(entry.name)}</td>
                    <td>${Number.isFinite(entry.size) ? entry.size : "-"}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      `;
    }
    flightControllerDialogStatus.textContent = `已读取 ${entries.length} 个条目。`;
  } catch (error) {
    flightLogList.innerHTML = `<div class="empty-state">读取失败：${escapeHtml(error.message)}</div>`;
    flightControllerDialogStatus.textContent = `读取目录失败：${error.message}`;
  } finally {
    refreshFlightLogList.disabled = false;
  }
});

restoreCachedLog();
