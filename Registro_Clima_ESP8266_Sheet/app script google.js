var TZ_ARG = "America/Argentina/Buenos_Aires";

function doGet(e) {
  var action = e && e.parameter ? e.parameter.action : "";
  if (action === "obtenerMaxLux" || action === "guardarMaxLux") {
    return procesarConfiguracionMaxLux(e);
  }
  if (action === "obtenerControl") {
    return obtenerConfiguracionControl(e);
  }
  if (action === "confirmarReinicio") {
    return confirmarReinicio(e);
  }

  if (e && e.parameter && Object.keys(e.parameter).length > 0 && !e.parameter.callback) {
    return procesarPeticion(e);
  }
  return obtenerDatosClima(e);
}

function doPost(e) {
  return procesarPeticion(e);
}

function obtenerConfiguracionControl(e) {
  var callback = e && e.parameter ? e.parameter.callback : "";

  try {
    var sheet = obtenerHojaControl();
    var minutos = Number(sheet.getRange("B1").getValue());
    if (!Number.isInteger(minutos) || minutos < 1 || minutos > 1440) {
      throw new Error("Control!B1 debe ser un número entero entre 1 y 1440.");
    }

    var reinicioSolicitado = sheet.getRange("B2").getValue() === true;
    if (e && e.parameter && e.parameter.formato === "plano") {
      return ContentService.createTextOutput(minutos + "|" + (reinicioSolicitado ? "1" : "0"))
        .setMimeType(ContentService.MimeType.TEXT);
    }

    return responderConfiguracion({
      status: "success",
      intervaloMinutos: minutos,
      reinicioSolicitado: reinicioSolicitado
    }, callback);
  } catch (err) {
    if (e && e.parameter && e.parameter.formato === "plano") {
      return ContentService.createTextOutput("ERROR|" + err.toString())
        .setMimeType(ContentService.MimeType.TEXT);
    }
    return responderConfiguracion({
      status: "error",
      message: err.toString()
    }, callback);
  }
}

function obtenerHojaControl() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Control");
  if (!sheet) {
    sheet = ss.insertSheet("Control");
    sheet.getRange("A1:B3").setValues([
      ["Intervalo de muestreo (minutos)", 3],
      ["Solicitar reinicio", false],
      ["Último reinicio confirmado", ""]
    ]);
    sheet.getRange("B2").insertCheckboxes();
    return sheet;
  }

  if (sheet.getRange("A1").isBlank()) {
    sheet.getRange("A1").setValue("Intervalo de muestreo (minutos)");
  }
  if (sheet.getRange("B1").isBlank()) {
    sheet.getRange("B1").setValue(3);
  }
  if (sheet.getRange("A2").isBlank()) {
    sheet.getRange("A2").setValue("Solicitar reinicio");
  }
  if (sheet.getRange("B2").isBlank()) {
    sheet.getRange("B2").insertCheckboxes();
  }
  if (sheet.getRange("A3").isBlank()) {
    sheet.getRange("A3").setValue("Último reinicio confirmado");
  }
  return sheet;
}

function confirmarReinicio() {
  try {
    var sheet = obtenerHojaControl();
    if (sheet.getRange("B2").getValue() === true) {
      sheet.getRange("B2").setValue(false);
      sheet.getRange("B3").setValue(new Date());
    }
    return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    return ContentService.createTextOutput("ERROR|" + err.toString())
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

function obtenerDatosClima(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Hoja 1");
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: "No se encontró la pestaña 'Hoja 1'."
    })).setMimeType(ContentService.MimeType.JSON);
  }

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[0]) continue;

    var fechaStr = r[0] instanceof Date
      ? Utilities.formatDate(r[0], TZ_ARG, "dd/MM/yyyy")
      : String(r[0]).trim();
    var horaStr = r[1] instanceof Date
      ? Utilities.formatDate(r[1], TZ_ARG, "HH:mm:ss")
      : String(r[1]).trim();

    var parseNum = function(value) {
      if (typeof value === "number") return value;
      if (!value && value !== 0) return 0;
      return parseFloat(String(value).replace(",", ".")) || 0;
    };
    var formatShortTime = function(value) {
      if (value instanceof Date) return Utilities.formatDate(value, TZ_ARG, "HH:mm");
      return String(value || "").trim();
    };

    rows.push({
      fecha: fechaStr,
      hora: horaStr,
      temp: parseNum(r[2]),
      hum: parseNum(r[3]),
      pres: parseNum(r[4]),
      luz: parseNum(r[5]),
      lluvia: Number(r[6]) === 1 || String(r[6]).toLowerCase() === "si" ? 1 : 0,
      estado: String(r[7] || "").trim(),
      st: parseNum(r[8]),
      rocio: parseNum(r[9]),
      amanecer: formatShortTime(r[10]),
      ocaso: formatShortTime(r[11]),
      durDia: String(r[12] || "").trim(),
      durNoche: String(r[13] || "").trim()
    });
  }

  var jsonString = JSON.stringify(rows);
  var callback = e && e.parameter ? e.parameter.callback : "";
  if (callback && /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) {
    return ContentService.createTextOutput(callback + "(" + jsonString + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(jsonString)
    .setMimeType(ContentService.MimeType.JSON);
}

function procesarPeticion(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Hoja 1");
    var sheetConfig = ss.getSheetByName("Configuracion");

    if (!sheet) {
      throw new Error("No se encontró la pestaña 'Hoja 1'.");
    }
    if (!sheetConfig) {
      throw new Error("No se encontró la pestaña 'Configuracion'.");
    }

    var data = {};

    if (e && e.parameter && Object.keys(e.parameter).length > 0) {
      data = e.parameter;
    } else if (e && e.postData && e.postData.contents) {
      try {
        data = JSON.parse(e.postData.contents);
      } catch (err) {
        data = {};
      }
    }

    var ahora = new Date();
    var fecha = Utilities.formatDate(ahora, TZ_ARG, "dd/MM/yyyy");
    var hora = Utilities.formatDate(ahora, TZ_ARG, "HH:mm:ss");

    function aNumero(valor) {
      if (valor === undefined || valor === null || valor === "") return "";
      var numero = parseFloat(valor.toString().replace(",", "."));
      return isNaN(numero) ? "" : numero;
    }

    var temperatura = aNumero(data.temperatura);
    var humedad = aNumero(data.humedad);
    var presion = aNumero(data.presion);
    var luz = aNumero(data.luz);
    var lluvia = aNumero(data.lluvia);
    var ipEstacion = data.ip || "";

    if (ipEstacion !== "") {
      sheetConfig.getRange("H4").setValue(ipEstacion);
      sheetConfig.getRange("H5").setValue(fecha + " " + hora);
    }

    var estadoClima = "";

    if (lluvia === 1) {
      estadoClima = "Lloviendo";
    } else {
      // getDisplayValues conserva las horas como se muestran en la hoja.
      var reglas = sheetConfig.getRange("A2:E10").getDisplayValues();
      var horaActual = Utilities.formatDate(ahora, TZ_ARG, "HH:mm");
      var horaActualNum = parseHora(horaActual);

      for (var i = 0; i < reglas.length; i++) {
        var nombreEstado = reglas[i][0];
        if (!nombreEstado) continue;

        var hInicio = parseHora(reglas[i][1]);
        var hFin = parseHora(reglas[i][2]);
        var luzMin = Number(reglas[i][3]);
        var luzMax = Number(reglas[i][4]);

        var horaEnRango;
        if (hInicio <= hFin) {
          horaEnRango = horaActualNum >= hInicio && horaActualNum < hFin;
        } else {
          // Rango nocturno que cruza medianoche.
          horaEnRango = horaActualNum >= hInicio || horaActualNum < hFin;
        }

        var luzEnRango = luz !== "" && luz >= luzMin && luz <= luzMax;

        if (horaEnRango && luzEnRango) {
          estadoClima = nombreEstado;
          break;
        }
      }

      if (estadoClima === "") {
        estadoClima = data.estado ? data.estado : "Sin Clasificar";
      }
    }

    var sensacionTermica = "";
    var puntoRocio = "";

    if (temperatura !== "" && humedad !== "") {
      var pr = temperatura - ((100 - humedad) / 5.0);
      puntoRocio = Math.round(pr * 10) / 10;

      var eSat = 6.11 * Math.exp(
        5417.7530 * (1 / 273.16 - 1 / (273.15 + pr))
      );
      var st = temperatura + 0.5555 * (eSat - 10);
      sensacionTermica = Math.round(st * 10) / 10;
    }

    var latitud = aNumero(sheetConfig.getRange("H1").getValue());
    var longitud = aNumero(sheetConfig.getRange("H2").getValue());
    if (latitud === "") latitud = -34.71;
    if (longitud === "") longitud = -58.30;
    var astro = calcularAmanecerOcaso(ahora, latitud, longitud);

    var proximaFila = Math.max(sheet.getLastRow() + 1, 2);

    sheet.getRange(proximaFila, 1, 1, 14).setValues([[
      fecha,
      hora,
      temperatura,
      humedad,
      presion,
      luz,
      lluvia,
      estadoClima,
      sensacionTermica,
      puntoRocio,
      astro.amanecerText,
      astro.ocasoText,
      astro.duracionDiaText,
      astro.duracionNocheText
    ]]);

    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      fila_insertada: proximaFila,
      fecha_arg: fecha,
      hora_arg: hora,
      temp_procesada: temperatura,
      hum_procesada: humedad,
      estado_calculado: estadoClima,
      sensacion: sensacionTermica,
      rocio: puntoRocio,
      amanecer: astro.amanecerText,
      ocaso: astro.ocasoText,
      duracion_dia: astro.duracionDiaText,
      duracion_noche: astro.duracionNocheText,
      ip_registrada: ipEstacion
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function procesarConfiguracionMaxLux(e) {
  var callback = e && e.parameter ? e.parameter.callback : "";

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetConfig = ss.getSheetByName("Configuracion");
    if (!sheetConfig) {
      throw new Error("No se encontró la pestaña 'Configuracion'.");
    }

    var maxLux;
    if (e.parameter.action === "obtenerMaxLux") {
      maxLux = leerMaxLux(sheetConfig);
    } else {
      maxLux = Number(e.parameter.maxLux);
      if (!Number.isFinite(maxLux) || maxLux <= 0) {
        throw new Error("El máximo de lux debe ser un número mayor que cero.");
      }

      validarCeldaMaxLux(sheetConfig);
      sheetConfig.getRange("F2").setValue(maxLux);
    }

    return responderConfiguracion({
      status: "success",
      maxLux: maxLux
    }, callback);
  } catch (err) {
    return responderConfiguracion({
      status: "error",
      message: err.toString()
    }, callback);
  }
}

function validarCeldaMaxLux(sheetConfig) {
  var labelRange = sheetConfig.getRange("F1");
  var valueRange = sheetConfig.getRange("F2");
  var label = String(labelRange.getValue() || "").trim();
  var value = valueRange.getValue();
  var expectedLabel = "Lux maximo de referencia (lx)";

  if (label && label !== expectedLabel) {
    throw new Error("Configuracion!F1 ya está ocupado; no se modificó la hoja.");
  }
  if (!label && value !== "" && value !== null) {
    throw new Error("Configuracion!F2 ya está ocupado; no se modificó la hoja.");
  }

  if (!label) labelRange.setValue(expectedLabel);
}

function leerMaxLux(sheetConfig) {
  validarCeldaMaxLux(sheetConfig);
  var valueRange = sheetConfig.getRange("F2");
  var value = valueRange.getValue();

  if (value === "" || value === null) {
    value = 100000;
    valueRange.setValue(value);
  }

  var maxLux = Number(value);
  if (!Number.isFinite(maxLux) || maxLux <= 0) {
    throw new Error("Configuracion!F2 debe ser un número mayor que cero.");
  }
  return maxLux;
}

function responderConfiguracion(data, callback) {
  var json = JSON.stringify(data);
  if (callback && /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) {
    return ContentService.createTextOutput(callback + "(" + json + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function calcularAmanecerOcaso(fecha, lat, lng) {
  var zenith = 90.833;
  var start = new Date(fecha.getFullYear(), 0, 0);
  var diff = fecha - start;
  var oneDay = 1000 * 60 * 60 * 24;
  var N = Math.floor(diff / oneDay);

  var lngHour = lng / 15.0;
  var tRise = N + ((6.0 - lngHour) / 24.0);
  var tSet = N + ((18.0 - lngHour) / 24.0);

  function calcularMomento(t, esAmanecer) {
    var M = (0.9856 * t) - 3.289;
    var L = M + (1.916 * sinDeg(M)) + (0.020 * sinDeg(2 * M)) + 282.634;
    L = normalizar0a360(L);

    var RA = atanDeg(0.91764 * tanDeg(L));
    RA = normalizar0a360(RA);
    var Lquadrant = Math.floor(L / 90.0) * 90.0;
    var RAquadrant = Math.floor(RA / 90.0) * 90.0;
    RA = (RA + (Lquadrant - RAquadrant)) / 15.0;

    var sinDec = 0.39782 * sinDeg(L);
    var cosDec = Math.cos(Math.asin(sinDec));
    var cosH = (cosDeg(zenith) - (sinDec * sinDeg(lat))) / (cosDec * cosDeg(lat));
    if (cosH > 1 || cosH < -1) return null;

    var H = esAmanecer ? (360.0 - acosDeg(cosH)) : acosDeg(cosH);
    H = H / 15.0;
    var T = H + RA - (0.06571 * t) - 6.622;
    var UT = normalizar0a24(T - lngHour);
    return normalizar0a24(UT - 3.0);
  }

  var hAmanecer = calcularMomento(tRise, true);
  var hOcaso = calcularMomento(tSet, false);
  var durDiaHrs = 0;
  if (hAmanecer !== null && hOcaso !== null) {
    durDiaHrs = hOcaso - hAmanecer;
    if (durDiaHrs < 0) durDiaHrs += 24.0;
  }

  return {
    amanecerText: decimalAHoraTexto(hAmanecer),
    ocasoText: decimalAHoraTexto(hOcaso),
    duracionDiaText: decimalAFormatoHorasMinutos(durDiaHrs),
    duracionNocheText: decimalAFormatoHorasMinutos(24.0 - durDiaHrs)
  };
}

function sinDeg(deg) { return Math.sin(deg * Math.PI / 180.0); }
function cosDeg(deg) { return Math.cos(deg * Math.PI / 180.0); }
function tanDeg(deg) { return Math.tan(deg * Math.PI / 180.0); }
function acosDeg(val) { return Math.acos(val) * 180.0 / Math.PI; }
function atanDeg(val) { return Math.atan(val) * 180.0 / Math.PI; }

function normalizar0a360(valor) {
  while (valor < 0) valor += 360.0;
  while (valor >= 360.0) valor -= 360.0;
  return valor;
}

function normalizar0a24(valor) {
  while (valor < 0) valor += 24.0;
  while (valor >= 24.0) valor -= 24.0;
  return valor;
}

function decimalAHoraTexto(decimal) {
  if (decimal === null) return "--:--";
  var horas = Math.floor(decimal);
  var minutos = Math.round((decimal - horas) * 60.0);
  if (minutos === 60) { horas += 1; minutos = 0; }
  return (horas < 10 ? "0" : "") + horas + ":" + (minutos < 10 ? "0" : "") + minutos;
}

function decimalAFormatoHorasMinutos(decimal) {
  var horas = Math.floor(decimal);
  var minutos = Math.round((decimal - horas) * 60.0);
  if (minutos === 60) { horas += 1; minutos = 0; }
  return horas + "h " + minutos + "m";
}

function parseHora(valorHora) {
  if (valorHora === undefined || valorHora === null || valorHora === "") {
    return 0;
  }

  var texto = valorHora.toString();

  if (texto.indexOf(":") !== -1) {
    var partes = texto.split(":");
    return Number(partes[0]) + (Number(partes[1]) / 60);
  }

  var numero = Number(texto);
  if (isNaN(numero)) return 0;

  // Si llega una fracción de día de Sheets, la convierte a horas.
  return numero >= 0 && numero < 1 ? numero * 24 : numero;
}

function probarLecturaConfiguracion() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetConfig = ss.getSheetByName("Configuracion");

  if (!sheetConfig) {
    Logger.log("ERROR: No se encontró la pestaña 'Configuracion'.");
    return;
  }

  var valores = sheetConfig.getRange("A1:E10").getDisplayValues();
  Logger.log("=== CONFIGURACION ===");

  for (var i = 0; i < valores.length; i++) {
    Logger.log(
      "Fila " + (i + 1) +
      ": Estado=" + valores[i][0] +
      " | H_Inicio=" + valores[i][1] +
      " | H_Fin=" + valores[i][2] +
      " | Luz_Min=" + valores[i][3] +
      " | Luz_Max=" + valores[i][4]
    );
  }
}