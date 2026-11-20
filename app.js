
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzSYNyQpOOjLdIgsXyUCfpI8I3yZIxtIPF6Gta2JBsch3OCaEKgWJ1RNQimsVy5SZ_9xQ/exec";

let allRecords = [];
let charts = {};
let maxLux = 100000;
const LUMINOSITY_GAMMA = 0.43;

const VAR_META = {
  temp: { label: "Temperatura", unit: "°C", color: "#fb7185" },
  st: { label: "Sensación Térmica", unit: "°C", color: "#f97316" },
  hum: { label: "Humedad Relativa", unit: "%", color: "#38bdf8" },
  rocio: { label: "Punto de Rocío", unit: "°C", color: "#2dd4bf" },
  pres: { label: "Presión Atmosférica", unit: "hPa", color: "#a78bfa" },
  luz: { label: "Luminosidad", unit: "%", color: "#fbbf24" }
};

document.addEventListener("DOMContentLoaded", () => {
  lucide.createIcons();
  setupNavigation();
  setupHistoryControls();
  setupConfiguration();
  loadMaxLux();
  loadWeatherData();

  // Auto-refresco cada 5 minutos
  setInterval(loadWeatherData, 5 * 60 * 1000);
});

function setupNavigation() {
  const buttons = document.querySelectorAll(".tab-btn");
  const views = document.querySelectorAll(".view");

  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      buttons.forEach(b => b.classList.remove("active"));
      views.forEach(v => v.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`view-${btn.dataset.view}`).classList.add("active");
    });
  });

  document.getElementById("btn-refresh").addEventListener("click", loadWeatherData);
}

function setupHistoryControls() {
  document.getElementById("select-var").addEventListener("change", updateHistoryView);
  document.getElementById("select-period").addEventListener("change", updateHistoryView);

  const scaleInputs = ["min-temp", "max-temp", "min-hum", "max-hum", "min-pres", "max-pres", "min-luz", "max-luz"];
  scaleInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", updateHistoryView);
  });

  const resetBtn = document.getElementById("btn-reset-scales");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      scaleInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      });
      updateHistoryView();
    });
  }
}

function setupConfiguration() {
  const maxLuxInput = document.getElementById("max-lux-reference");
  maxLuxInput.value = maxLux;
  document.getElementById("config-form").addEventListener("submit", event => {
    event.preventDefault();
    const newMaxLux = Number(maxLuxInput.value);
    const feedback = document.getElementById("config-feedback");
    const saveButton = document.querySelector("#config-form button[type='submit']");

    if (!Number.isFinite(newMaxLux) || newMaxLux <= 0) {
      feedback.textContent = "Ingresá un máximo de lux mayor que cero.";
      feedback.classList.add("error");
      return;
    }

    feedback.textContent = "Guardando en Google Sheets...";
    feedback.classList.remove("error");
    saveButton.disabled = true;

    requestMaxLux("guardarMaxLux", newMaxLux, "handleMaxLuxSaveJSONP", response => {
      try {
        maxLux = parseMaxLuxResponse(response);
        maxLuxInput.value = maxLux;
        feedback.textContent = "Máximo de luminosidad guardado en Google Sheets.";
        if (allRecords.length > 0) renderDashboard();
        updateHistoryView();
      } catch (error) {
        feedback.textContent = error.message;
        feedback.classList.add("error");
      } finally {
        saveButton.disabled = false;
      }
    }, error => {
      feedback.textContent = error.message;
      feedback.classList.add("error");
      saveButton.disabled = false;
    });
  });
}

function loadMaxLux() {
  const feedback = document.getElementById("config-feedback");

  requestMaxLux("obtenerMaxLux", null, "handleMaxLuxJSONP", response => {
    try {
      maxLux = parseMaxLuxResponse(response);
      document.getElementById("max-lux-reference").value = maxLux;
      feedback.textContent = "Máximo cargado desde Google Sheets.";
      feedback.classList.remove("error");
      if (allRecords.length > 0) renderDashboard();
      updateHistoryView();
    } catch (error) {
      feedback.textContent = error.message;
      feedback.classList.add("error");
    }
  }, error => {
    feedback.textContent = error.message;
    feedback.classList.add("error");
  });
}

function parseMaxLuxResponse(response) {
  if (!response || response.status !== "success") {
    throw new Error(response && response.message
      ? response.message
      : "Google Sheets no devolvió una configuración válida.");
  }

  const value = Number(response.maxLux);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("El máximo de lux guardado en Google Sheets no es válido.");
  }

  return value;
}

function requestMaxLux(action, value, callbackName, onSuccess, onError) {
  const scriptId = `jsonp-${callbackName}`;
  const previousScript = document.getElementById(scriptId);
  if (previousScript) previousScript.remove();

  const script = document.createElement("script");
  script.id = scriptId;
  const url = new URL(APPS_SCRIPT_URL);
  url.searchParams.set("action", action);
  url.searchParams.set("callback", callbackName);
  url.searchParams.set("t", String(Date.now()));
  if (value !== null) url.searchParams.set("maxLux", String(value));

  let timeoutId;
  const cleanup = () => {
    clearTimeout(timeoutId);
    delete window[callbackName];
    script.remove();
  };

  window[callbackName] = response => {
    cleanup();
    onSuccess(response);
  };
  script.onerror = () => {
    cleanup();
    onError(new Error("No se pudo comunicar con la configuración de Google Sheets."));
  };
  timeoutId = setTimeout(() => {
    cleanup();
    onError(new Error("Google Sheets no respondió al pedido de configuración."));
  }, 15000);

  script.src = url.toString();
  document.body.appendChild(script);
}

function toLuminosityPercent(lux) {
  const value = Number(lux);
  if (lux === "" || lux === null || lux === undefined || !Number.isFinite(value)) {
    throw new Error("La hoja contiene una lectura de luminosidad no válida.");
  }
  const normalizedLux = Math.max(0, value / maxLux);
  return Math.min(100, Math.pow(normalizedLux, LUMINOSITY_GAMMA) * 100);
}

function loadWeatherData() {
  const banner = document.getElementById("status-banner");
  const refreshBtn = document.getElementById("btn-refresh");
  
  banner.className = "status-banner";
  banner.innerHTML = `<span class="pulse"></span> Sincronizando datos con Google Sheets...`;
  refreshBtn.classList.add("spinning");

  if (APPS_SCRIPT_URL.includes("PEGAR_AQUI")) {
    banner.className = "status-banner error";
    banner.textContent = "Aviso: Falta configurar la URL del Google Apps Script en app.js";
    refreshBtn.classList.remove("spinning");
    return;
  }

  window.handleWeatherJSONP = function(rawData) {
    try {
      allRecords = rawData.map(item => {
        const ts = parseFechaArgentina(item.fecha, item.hora);
        const shortDate = item.fecha.includes("/") 
          ? item.fecha.slice(0, 5) 
          : `${item.fecha.slice(8, 10)}/${item.fecha.slice(5, 7)}`;
        return {
          ...item,
          timestamp: isNaN(ts) ? Date.now() : ts,
          shortLabel: `${shortDate} ${item.hora.slice(0, 5)}`
        };
      });

      if (allRecords.length === 0) {
        throw new Error("La hoja no contiene registros todavía.");
      }

      banner.classList.add("hidden");
      renderDashboard();
      updateHistoryView();
    } catch (err) {
      banner.className = "status-banner error";
      banner.textContent = `Aviso: ${err.message}`;
    } finally {
      refreshBtn.classList.remove("spinning");
      const oldScript = document.getElementById("jsonp-weather");
      if (oldScript) oldScript.remove();
    }
  };

  const oldScript = document.getElementById("jsonp-weather");
  if (oldScript) oldScript.remove();

  const script = document.createElement("script");
  script.id = "jsonp-weather";
  script.src = `${APPS_SCRIPT_URL}?callback=handleWeatherJSONP&t=${Date.now()}`;
  script.onerror = function() {
    banner.className = "status-banner error";
    banner.textContent = "Aviso: No se pudo conectar con Google Apps Script.";
    refreshBtn.classList.remove("spinning");
  };
  document.body.appendChild(script);
}


function parseFechaArgentina(fechaStr, horaStr) {
  // Soporta tanto "16/11/2026" como "2026-11-16"
  let y, m, d;
  if (fechaStr.includes("/")) {
    const parts = fechaStr.split("/");
    d = Number(parts[0]);
    m = Number(parts[1]) - 1;
    y = Number(parts[2]);
  } else {
    const parts = fechaStr.split("-");
    y = Number(parts[0]);
    m = Number(parts[1]) - 1;
    d = Number(parts[2]);
  }
  const tParts = (horaStr || "00:00:00").split(":");
  return new Date(y, m, d, Number(tParts[0] || 0), Number(tParts[1] || 0), Number(tParts[2] || 0)).getTime();
}


function renderDashboard() {
  const latest = allRecords[allRecords.length - 1];

  // Timestamps y Ciclo Solar
  document.getElementById("last-timestamp").textContent = `${latest.fecha} ${latest.hora}`;
  document.getElementById("val-amanecer").textContent = latest.amanecer || "--:--";
  document.getElementById("val-ocaso").textContent = latest.ocaso || "--:--";
  document.getElementById("val-dur-dia").textContent = latest.durDia || "--";
  document.getElementById("val-dur-noche").textContent = latest.durNoche || "--";

  // Estado del cielo e ícono
  document.getElementById("sky-state").textContent = latest.estado || "Sin datos";
  updateSkyIcon(latest.estado, latest.lluvia);

  const rainPill = document.getElementById("rain-status");
  if (latest.lluvia === 1) {
    rainPill.textContent = "Lluvia detectada";
    rainPill.classList.add("raining");
  } else {
    rainPill.textContent = "Sin precipitaciones";
    rainPill.classList.remove("raining");
  }

  // Tarjetas numéricas
  document.getElementById("val-temp").textContent = latest.temp.toFixed(1);
  document.getElementById("val-st").textContent = `${latest.st.toFixed(1)} °C`;
  document.getElementById("val-hum").textContent = latest.hum.toFixed(1);
  document.getElementById("val-rocio").textContent = `${latest.rocio.toFixed(1)} °C`;
  document.getElementById("val-pres").textContent = latest.pres.toFixed(1);
  document.getElementById("val-luz").textContent = toLuminosityPercent(latest.luz).toFixed(1);

  // Tendencia barométrica (comparando con hace 3 horas = ~36 registros de 5 min)
  const idx3h = Math.max(0, allRecords.length - 37);
  const diffPres = latest.pres - allRecords[idx3h].pres;
  const presTrendEl = document.getElementById("pres-trend");
  if (diffPres > 0.6) presTrendEl.textContent = `▲ Subiendo (+${diffPres.toFixed(1)} hPa / 3h)`;
  else if (diffPres < -0.6) presTrendEl.textContent = `▼ Bajando (${diffPres.toFixed(1)} hPa / 3h)`;
  else presTrendEl.textContent = `► Estable (${diffPres >= 0 ? "+" : ""}${diffPres.toFixed(1)} hPa / 3h)`;

  // Filtrar últimas 24 horas para los gráficos del dashboard
  const cutoff24h = latest.timestamp - (24 * 60 * 60 * 1000);
  const last24h = allRecords.filter(r => r.timestamp >= cutoff24h);
  const labels = last24h.map(r => r.hora.slice(0, 5));

  // Gráfico 1: Temperatura y Sensación Térmica
  renderLineChart("chart-temp-24h", labels, [
    {
      label: "Temperatura (°C)",
      data: last24h.map(r => r.temp),
      borderColor: "#fb7185",
      backgroundColor: "rgba(251, 113, 133, 0.12)",
      fill: true
    },
    {
      label: "Sensación Térmica (°C)",
      data: last24h.map(r => r.st),
      borderColor: "#f97316",
      borderDash: [5, 5],
      fill: false
    }
  ]);

// Gráfico 2: Humedad y Luminosidad (con Doble Eje Y)
  renderLineChart("chart-hum-luz-24h", labels, [
    {
      label: "Humedad (%)",
      data: last24h.map(r => r.hum),
      borderColor: "#38bdf8",
      backgroundColor: "rgba(56, 189, 248, 0.1)",
      fill: true,
      yAxisID: "y"
    },
    {
      label: "Luminosidad (%)",
      data: last24h.map(r => toLuminosityPercent(r.luz)),
      borderColor: "#fbbf24",
      fill: false,
      yAxisID: "y1"
    }
  ]);

  // Gráfico 3: Presión
  renderLineChart("chart-pres-24h", labels, [
    {
      label: "Presión (hPa)",
      data: last24h.map(r => r.pres),
      borderColor: "#a78bfa",
      backgroundColor: "rgba(167, 139, 250, 0.15)",
      fill: true
    }
  ]);
}

function updateSkyIcon(estado, lluvia) {
  const container = document.getElementById("sky-icon-container");
  let iconName = "sun";
  let color = "#fbbf24";

  if (lluvia === 1) {
    iconName = "cloud-rain";
    color = "#38bdf8";
  } else {
    const est = (estado || "").toLowerCase();
    if (est.includes("noche")) {
      iconName = "moon";
      color = "#a78bfa";
    } else if (est.includes("muy nublado")) {
      iconName = "cloudy";
      color = "#94a3b8";
    } else if (est.includes("parcialmente")) {
      iconName = "cloud-sun";
      color = "#fbbf24";
    } else {
      iconName = "sun";
      color = "#fbbf24";
    }
  }

  container.innerHTML = `<i data-lucide="${iconName}" style="color: ${color}"></i>`;
  lucide.createIcons();
}

function updateHistoryView() {
  if (allRecords.length === 0) return;

  const variable = document.getElementById("select-var").value;
  const periodDays = document.getElementById("select-period").value;
  const meta = VAR_META[variable];

  const latestTs = allRecords[allRecords.length - 1].timestamp;
  let filtered = allRecords;

  if (periodDays !== "all") {
    const cutoff = latestTs - (Number(periodDays) * 24 * 60 * 60 * 1000);
    filtered = allRecords.filter(r => r.timestamp >= cutoff);
  }

  document.getElementById("stat-count").textContent = `${filtered.length} registros`;
  if (filtered.length === 0) return;

  // Cálculo de estadísticas
  let maxRec = filtered[0];
  let minRec = filtered[0];
  let sum = 0;
  const values = [];

  for (const r of filtered) {
    const v = variable === "luz" ? toLuminosityPercent(r[variable]) : r[variable];
    const maxValue = variable === "luz" ? toLuminosityPercent(maxRec[variable]) : maxRec[variable];
    const minValue = variable === "luz" ? toLuminosityPercent(minRec[variable]) : minRec[variable];
    if (v > maxValue) maxRec = r;
    if (v < minValue) minRec = r;
    sum += v;
    values.push(v);
  }

  const avg = sum / filtered.length;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 !== 0 ? values[mid] : (values[mid - 1] + values[mid]) / 2;

  const fmt = (num) => `${num.toFixed(1)} ${meta.unit}`;

  const maxValue = variable === "luz" ? toLuminosityPercent(maxRec[variable]) : maxRec[variable];
  const minValue = variable === "luz" ? toLuminosityPercent(minRec[variable]) : minRec[variable];
  document.getElementById("stat-max").textContent = fmt(maxValue);
  document.getElementById("stat-max-time").textContent = `${maxRec.fecha} a las ${maxRec.hora.slice(0, 5)}`;

  document.getElementById("stat-min").textContent = fmt(minValue);
  document.getElementById("stat-min-time").textContent = `${minRec.fecha} a las ${minRec.hora.slice(0, 5)}`;

  document.getElementById("stat-avg").textContent = fmt(avg);
  document.getElementById("stat-med").textContent = fmt(median);

  // Si hay demasiados puntos (ej. 1 mes = ~8600 puntos), muestreamos para que el gráfico sea fluido
  const maxPoints = 500;
  const step = Math.max(1, Math.ceil(filtered.length / maxPoints));
  const sampled = filtered.filter((_, idx) => idx % step === 0);

  document.getElementById("hist-chart-title").textContent = `${meta.label} (${meta.unit}) - Evolución del período`;

  renderLineChart("chart-historico", sampled.map(r => r.shortLabel), [
    
    {
      
      label: `${meta.label} (${meta.unit})`,
      data: sampled.map(r => variable === "luz" ? toLuminosityPercent(r[variable]) : r[variable]),
      borderColor: meta.color,
      backgroundColor: meta.color + "22",
      fill: true
    }
    
  ]);
  renderMultiCorrelationChart(sampled);
}

function renderLineChart(canvasId, labels, datasets) {
  const ctx = document.getElementById(canvasId).getContext("2d");

  if (charts[canvasId]) {
    charts[canvasId].destroy();
  }

  const hasSecondAxis = datasets.some(ds => ds.yAxisID === "y1");

  const formattedDatasets = datasets.map(ds => ({
    ...ds,
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 4,
    tension: 0.3
  }));

  const scalesConfig = {
    x: {
      ticks: { color: "#64748b", maxTicksLimit: 10 },
      grid: { color: "rgba(35, 47, 75, 0.5)" }
    },
    y: {
      type: "linear",
      display: true,
      position: "left",
      ticks: { color: hasSecondAxis ? "#38bdf8" : "#64748b" },
      grid: { color: "rgba(35, 47, 75, 0.5)" }
    }
  };

  if (hasSecondAxis) {
    scalesConfig.y1 = {
      type: "linear",
      display: true,
      position: "right",
      min: 0,
      max: 100,
      ticks: { color: "#fbbf24" },
      grid: { drawOnChartArea: false } // Evita que se crucen dos grillas distintas
    };
  }

  charts[canvasId] = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: formattedDatasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          labels: { color: "#94a3b8", boxWidth: 12 }
        }
      },
      scales: scalesConfig
    }
  });
}
function renderMultiCorrelationChart(records) {
  const canvas = document.getElementById("chart-correlacion-4vars");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  if (charts["chart-correlacion-4vars"]) {
    charts["chart-correlacion-4vars"].destroy();
  }

  const getVal = (id) => {
    const el = document.getElementById(id);
    if (!el || el.value === "") return undefined;
    const n = parseFloat(el.value);
    return isNaN(n) ? undefined : n;
  };

  const labels = records.map(r => r.shortLabel);

  charts["chart-correlacion-4vars"] = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Temperatura (°C)",
          data: records.map(r => r.temp),
          borderColor: "#fb7185",
          backgroundColor: "rgba(251, 113, 133, 0.1)",
          yAxisID: "yTemp",
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3
        },
        {
          label: "Humedad (%)",
          data: records.map(r => r.hum),
          borderColor: "#38bdf8",
          backgroundColor: "rgba(56, 189, 248, 0.1)",
          yAxisID: "yHum",
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3
        },
        {
          label: "Presión (hPa)",
          data: records.map(r => r.pres),
          borderColor: "#a78bfa",
          backgroundColor: "rgba(167, 139, 250, 0.1)",
          yAxisID: "yPres",
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3
        },
        {
          label: "Luminosidad (%)",
          data: records.map(r => toLuminosityPercent(r.luz)),
          borderColor: "#fbbf24",
          backgroundColor: "rgba(251, 191, 36, 0.1)",
          yAxisID: "yLuz",
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          labels: { color: "#e2e8f0", boxWidth: 12 },
          onClick: (e, legendItem, legend) => {
            // Comportamiento estándar de ocultar/mostrar línea
            Chart.defaults.plugins.legend.onClick(e, legendItem, legend);
            // Ocultar también su eje Y correspondiente para limpiar la vista
            const ci = legend.chart;
            const axisMap = ["yTemp", "yHum", "yPres", "yLuz"];
            const axisId = axisMap[legendItem.datasetIndex];
            if (axisId && ci.options.scales[axisId]) {
              ci.options.scales[axisId].display = ci.isDatasetVisible(legendItem.datasetIndex);
              ci.update();
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#64748b", maxTicksLimit: 10 },
          grid: { color: "rgba(35, 47, 75, 0.5)" }
        },
        yTemp: {
          type: "linear",
          position: "left",
          min: getVal("min-temp"),
          max: getVal("max-temp"),
          ticks: { color: "#fb7185" },
          title: { display: true, text: "°C", color: "#fb7185" },
          grid: { color: "rgba(35, 47, 75, 0.4)" }
        },
        yHum: {
          type: "linear",
          position: "left",
          min: getVal("min-hum"),
          max: getVal("max-hum"),
          ticks: { color: "#38bdf8" },
          title: { display: true, text: "%", color: "#38bdf8" },
          grid: { drawOnChartArea: false }
        },
        yPres: {
          type: "linear",
          position: "right",
          min: getVal("min-pres"),
          max: getVal("max-pres"),
          ticks: { color: "#a78bfa" },
          title: { display: true, text: "hPa", color: "#a78bfa" },
          grid: { drawOnChartArea: false }
        },
        yLuz: {
          type: "linear",
          position: "right",
          min: getVal("min-luz") === undefined ? 0 : getVal("min-luz"),
          max: getVal("max-luz") === undefined ? 100 : getVal("max-luz"),
          ticks: { color: "#fbbf24" },
          title: { display: true, text: "%", color: "#fbbf24" },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });
}