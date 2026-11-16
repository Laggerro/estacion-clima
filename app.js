// REEMPLAZÁ ESTA URL POR LA DE TU GOOGLE APPS SCRIPT IMPLEMENTADO
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzSYNyQpOOjLdIgsXyUCfpI8I3yZIxtIPF6Gta2JBsch3OCaEKgWJ1RNQimsVy5SZ_9xQ/exec";

let allRecords = [];
let charts = {};

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
}

async function loadWeatherData() {
  const banner = document.getElementById("status-banner");
  const refreshBtn = document.getElementById("btn-refresh");
  
  banner.className = "status-banner";
  banner.innerHTML = `<span class="pulse"></span> Sincronizando datos con Google Sheets...`;
  refreshBtn.classList.add("spinning");

  try {
    if (APPS_SCRIPT_URL.includes("PEGAR_AQUI")) {
      throw new Error("Falta configurar la URL del Google Apps Script en app.js");
    }

    const response = await fetch(APPS_SCRIPT_URL);
    if (!response.ok) throw new Error(`Error HTTP: ${response.status}`);
    
    const rawData = await response.json();
    
    // Parsear timestamps para poder filtrar por fechas
    allRecords = rawData.map(item => {
  const ts = parseFechaArgentina(item.fecha, item.hora);
  // shortLabel muestra "16/11 12:40"
  const shortDate = item.fecha.includes("/") ? item.fecha.slice(0, 5) : `${item.fecha.slice(8, 10)}/${item.fecha.slice(5, 7)}`;
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
  }
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
  document.getElementById("val-luz").textContent = Math.round(latest.luz);

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

  // Gráfico 2: Humedad y Luminosidad
  renderLineChart("chart-hum-luz-24h", labels, [
    {
      label: "Humedad (%)",
      data: last24h.map(r => r.hum),
      borderColor: "#38bdf8",
      backgroundColor: "rgba(56, 189, 248, 0.1)",
      fill: true
    },
    {
      label: "Luminosidad (%)",
      data: last24h.map(r => r.luz),
      borderColor: "#fbbf24",
      fill: false
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
    const v = r[variable];
    if (v > maxRec[variable]) maxRec = r;
    if (v < minRec[variable]) minRec = r;
    sum += v;
    values.push(v);
  }

  const avg = sum / filtered.length;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 !== 0 ? values[mid] : (values[mid - 1] + values[mid]) / 2;

  const fmt = (num) => `${num.toFixed(1)} ${meta.unit}`;

  document.getElementById("stat-max").textContent = fmt(maxRec[variable]);
  document.getElementById("stat-max-time").textContent = `${maxRec.fecha} a las ${maxRec.hora.slice(0, 5)}`;

  document.getElementById("stat-min").textContent = fmt(minRec[variable]);
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
      data: sampled.map(r => r[variable]),
      borderColor: meta.color,
      backgroundColor: meta.color + "22",
      fill: true
    }
  ]);
}

function renderLineChart(canvasId, labels, datasets) {
  const ctx = document.getElementById(canvasId).getContext("2d");

  if (charts[canvasId]) {
    charts[canvasId].destroy();
  }

  const formattedDatasets = datasets.map(ds => ({
    ...ds,
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 4,
    tension: 0.3
  }));

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
      scales: {
        x: {
          ticks: { color: "#64748b", maxTicksLimit: 10 },
          grid: { color: "rgba(35, 47, 75, 0.5)" }
        },
        y: {
          ticks: { color: "#64748b" },
          grid: { color: "rgba(35, 47, 75, 0.5)" }
        }
      }
    }
  });
}