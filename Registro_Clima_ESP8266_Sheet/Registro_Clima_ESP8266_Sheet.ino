/*
 ==============================================================================
                     ESTACIÓN METEOROLÓGICA ESP8266 (NodeMCU / Wemos)
 ==============================================================================
 
 1. HARDWARE Y CONEXIONES DE PINES:
    -----------------------------------------------------------------
    * Alimentación General: 3.3V y GND comunes para todos los sensores.
    * Bus I2C Compartido (BME280 + BH1750):
      - SDA (Datos)  -> Pin D2 (GPIO 4)
      - SCL (Reloj)  -> Pin D1 (GPIO 5)
    * Sensor de Lluvia (Digital):
      - Señal        -> Pin D5 (GPIO 14) [Configurado con INPUT_PULLUP]
    * LED RGB (Ánodo Común - Pata larga a 3.3V / Resistencias de 220Ω por canal):
      - Pin Rojo     -> Pin D6 (GPIO 12)
      - Pin Verde    -> Pin D7 (GPIO 13)
      - Pin Azul     -> Pin D8 (GPIO 15)

 2. LÓGICA DE INDICACIÓN VISUAL (LED RGB):
    -----------------------------------------------------------------
    * Azul parpadeante lento: Sistema operando con normalidad (en espera).
    * Verde parpadeante rápido: Sincronizando y enviando datos a Google Sheets.
    * Rojo fijo: Error de sincronización con Google Sheets (Falla HTTP, URL 
                inválida, bloqueo o cambio de credenciales de red).
    * Rojo parpadeante lento: Error en el sensor BME280 (lectura inválida/fallo I2C).
    * Rojo parpadeante rápido: Sin conexión a la red Wi-Fi configurada.
    * Alternando Rojo y Azul: Modo Configuración / AP Activo ('Estacion-Meteo-Config').

 3. FUNCIONAMIENTO Y CARACTERÍSTICAS TÉCNICAS:
    -----------------------------------------------------------------
    * Monitoreo ambiental: Temperatura, humedad, presión atmosférica, 
      luminosidad (Luxes a % con ajuste anti-cero en interiores) y lluvia.
    * Registro de datos: Envío automático al intervalo configurado en la pestaña
      Control de Google Sheets, mediante HTTPS y redirección estricta.
    * Resiliencia y configuración: Credenciales WiFi y URL de Apps Script en EEPROM.
      Si falla la conexión, reintenta y de persistir inicia el AP de configuración (192.168.4.1).
    * Servidor Web local: Interfaz integrada alojada en LittleFS para consultar 
      el estado de los sensores, revisar logs en tiempo real y reconfigurar la red.
 ==============================================================================
*/
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <LittleFS.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <BH1750.h>
#include <EEPROM.h>

// ==========================================
// CONFIGURACIÓN EEPROM Y GOOGLE SHEETS
// ==========================================
const size_t SERVER_URL_EEPROM_START = 66;
const size_t SERVER_URL_EEPROM_SIZE = 446;

// ==========================================
// PINES ESP8266 (NodeMCU / Wemos D1 Mini)
// ==========================================
#define I2C_SDA      4   // D2 en NodeMCU
#define I2C_SCL      5   // D1 en NodeMCU
const int PIN_LLUVIA = 15; // D8 en NodeMCU

// Pines LED RGB (Ánodo Común: LOW = Encendido, HIGH = Apagado)
const int LED_ROJO   = 14; // D5
const int LED_VERDE  = 12; // D6
const int LED_AZUL   = 13; // D7

// El intervalo se carga desde EEPROM y se sincroniza con Google Sheets (por defecto 3 minutos).
unsigned long INTERVALO_ENVIO = 180000; // en milisegundos
int intervaloMinutos = 3; 
unsigned long ultimoEnvio = 0;
unsigned long ultimoChequeoConfiguracion = 0;

// Control de parpadeo del LED (No bloqueante)
unsigned long anteriorMillisLED = 0;
bool estadoLedIntermitente = false;
int alternadorAP = 0;

// Objetos globales
ESP8266WebServer server(80);
Adafruit_BME280 bme;
BH1750 lightMeter;

// Variables de estado y diagnóstico
bool bme280_ok = false;
bool bh1750_ok = false;
bool modoAP = false;
bool enviandoAhora = false;
bool syncGoogleError = false;
String wifiSSID = "";
String wifiPass = "";
String serverUrl = "";
String ipGuardada = "Ninguna";
String ultimoEstadoHTTP = "Sin envíos aún";
String historialLogs = "";

// Valores actuales de sensores
float tempActual   = -999.0;
float humActual    = -1.0;
float presActual   = -999.0;
int   luzActual    = -1;
int   lluviaActual = 0;

// Funciones LED
void apagarLEDs() {
  digitalWrite(LED_ROJO, HIGH);
  digitalWrite(LED_VERDE, HIGH);
  digitalWrite(LED_AZUL, HIGH);
}
void encenderRojo() { apagarLEDs(); digitalWrite(LED_ROJO, LOW); }
void encenderVerde() { apagarLEDs(); digitalWrite(LED_VERDE, LOW); }
void encenderAzul() { apagarLEDs(); digitalWrite(LED_AZUL, LOW); }

void agregarLog(String msg) {
  unsigned long seg = millis() / 1000;
  unsigned long min = seg / 60;
  unsigned long hr  = min / 60;
  String tiempo = "[" + String(hr) + "h " + String(min % 60) + "m " + String(seg % 60) + "s] ";
  String linea = tiempo + msg;
  Serial.println(linea);
  
  historialLogs += linea + "\n";
  if (historialLogs.length() > 2200) {
    historialLogs = historialLogs.substring(historialLogs.length() - 2200);
  }
}

bool esUrlAppsScriptValida(String url) {
  url.trim();
  const String prefijo = "https://script.google.com/macros/s/";
  const String sufijo = "/exec";
  if (!url.startsWith(prefijo) || !url.endsWith(sufijo) ||
      url.length() >= SERVER_URL_EEPROM_SIZE ||
      url.indexOf('?') >= 0 || url.indexOf('#') >= 0) {
    return false;
  }
  String idImplementacion = url.substring(prefijo.length(), url.length() - sufijo.length());
  return idImplementacion.length() > 0 && idImplementacion.indexOf('/') < 0;
}

// EEPROM: [0-31] SSID | [32-63] PASS | [64-65] Intervalo | [66-511] URL
void guardarConfigEEPROM(String s, String p, int minutos, String url) {
  EEPROM.begin(512);
  for (int i = 0; i < 66; ++i) EEPROM.write(i, 0); // limpiar bloques anteriores
  
  for (unsigned int i = 0; i < s.length() && i < 31; ++i) EEPROM.write(i, s[i]);
  for (unsigned int i = 0; i < p.length() && i < 31; ++i) EEPROM.write(32 + i, p[i]);
  EEPROM.write(64, (uint8_t)(minutos & 0xFF));
  EEPROM.write(65, (uint8_t)((minutos >> 8) & 0xFF));
  for (size_t i = 0; i < SERVER_URL_EEPROM_SIZE; ++i) {
    EEPROM.write(SERVER_URL_EEPROM_START + i, 0);
  }
  for (size_t i = 0; i < url.length() && i < SERVER_URL_EEPROM_SIZE - 1; ++i) {
    EEPROM.write(SERVER_URL_EEPROM_START + i, url[i]);
  }
  
  EEPROM.commit();
  agregarLog("[EEPROM] Wi-Fi, URL de Google Sheets e intervalo guardados.");
}

void cargarConfigEEPROM() {
  EEPROM.begin(512);
  char s[32] = {0};
  char p[32] = {0};
  for (int i = 0; i < 31; ++i) {
    uint8_t byteLeido = EEPROM.read(i);
    if (byteLeido == 0 || byteLeido == 0xFF) break;
    s[i] = (char)byteLeido;
  }
  for (int i = 0; i < 31; ++i) {
    uint8_t byteLeido = EEPROM.read(32 + i);
    if (byteLeido == 0 || byteLeido == 0xFF) break;
    p[i] = (char)byteLeido;
  }
  uint8_t intervaloBajo = EEPROM.read(64);
  uint8_t intervaloAlto = EEPROM.read(65);
  char url[SERVER_URL_EEPROM_SIZE] = {0};
  for (size_t i = 0; i < SERVER_URL_EEPROM_SIZE - 1; ++i) {
    uint8_t byteLeido = EEPROM.read(SERVER_URL_EEPROM_START + i);
    if (byteLeido == 0 || byteLeido == 0xFF) break;
    url[i] = (char)byteLeido;
  }
  uint16_t minGuardados = 0;
  if (intervaloBajo == 0xFF && intervaloAlto == 0xFF) {
    minGuardados = 0;
  } else if (intervaloAlto == 0xFF) {
    minGuardados = intervaloBajo; // Compatibilidad con el formato anterior de un byte.
  } else {
    minGuardados = (uint16_t)intervaloBajo | ((uint16_t)intervaloAlto << 8);
  }

  String readS = String(s);
  String readP = String(p);

  wifiSSID = readS;
  wifiPass = readP;
  String urlLeida = String(url);
  serverUrl = esUrlAppsScriptValida(urlLeida) ? urlLeida : "";
  
  if (minGuardados > 0 && minGuardados <= 1440) {
    intervaloMinutos = minGuardados;
  } else {
    intervaloMinutos = 3; // Valor por defecto
  }
  
  INTERVALO_ENVIO = (unsigned long)intervaloMinutos * 60000UL; // Convertir a milisegundos
  agregarLog("[EEPROM] Wi-Fi " + String(wifiSSID.length() ? "configurado" : "sin configurar") +
             " | URL de Sheets " + String(serverUrl.length() ? "configurada" : "sin configurar") +
             " | Intervalo: " + String(intervaloMinutos) + " min");
}

void inicializarSensores() {
  agregarLog("[SENSORES] Iniciando bus I2C...");
  Wire.begin(I2C_SDA, I2C_SCL);

  if (bme.begin(0x76, &Wire) || bme.begin(0x77, &Wire)) {
    bme280_ok = true;
    agregarLog("[BME280] Inicializado correctamente.");
  } else {
    bme280_ok = false;
    agregarLog("[BME280] ERROR: No se detectó el sensor.");
  }

  if (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23, &Wire) ||
      lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x5C, &Wire)) {
    bh1750_ok = true;
    agregarLog("[BH1750] Inicializado correctamente.");
  } else {
    bh1750_ok = false;
    agregarLog("[BH1750] INFO: No conectado.");
  }
}

void leerSensores() {
  if (bme280_ok) {
    float t = bme.readTemperature();
    float h = bme.readHumidity();
    float p = bme.readPressure() / 100.0F;

    if (isnan(t) || isnan(h) || isnan(p) || p < 300.0) {
      tempActual = -999.0; humActual = -1.0; presActual = -999.0;
      bme280_ok = (bme.begin(0x76, &Wire) || bme.begin(0x77, &Wire));
    } else {
      tempActual = t; humActual = h; presActual = p;
    }
  } else {
    tempActual = -999.0; humActual = -1.0; presActual = -999.0;
  }

if (bh1750_ok) {
    float luxVal = lightMeter.readLightLevel();
    if (isnan(luxVal) || luxVal < 0) {
      luzActual = -1;
      bh1750_ok = (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23, &Wire) || 
                   lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x5C, &Wire));
    } else {
      // Guardamos el valor directo en Lux redondeado al entero más cercano
      luzActual = (int)(luxVal + 0.5);
    }
  } else {
    luzActual = -1;
  }

// Forzamos en 0 (Seco) temporalmente hasta conectar el sensor
lluviaActual = 0;
  //lluviaActual = (digitalRead(PIN_LLUVIA) == LOW) ? 1 : 0; // descomentar para enviar el estado correctamente
}

bool conectarWiFi() {
  WiFi.disconnect(true);
  delay(200);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(wifiSSID.c_str(), wifiPass.c_str());

  int intentos = 0;
  while (WiFi.status() != WL_CONNECTED && intentos < 30) {
    delay(500);
    intentos++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    modoAP = false;
    ipGuardada = WiFi.localIP().toString();
    agregarLog("[WIFI] Conectado. IP: " + ipGuardada);
    return true;
  } else {
    agregarLog("[WIFI] ERROR: Fallo al conectar a " + wifiSSID);
    WiFi.disconnect(true);
    return false;
  }
}

void activarModoAP() {
  modoAP = true;
  WiFi.mode(WIFI_AP);
  WiFi.softAP("Estacion-Meteo-Config", "12345678");
  agregarLog("[WIFI-AP] Modo Configuración activo (192.168.4.1).");
}

void enviarDatos() {
  enviandoAhora = true;
  leerSensores();

  if (!serverUrl.length()) {
    ultimoEstadoHTTP = "URL Google Sheets no configurada";
    syncGoogleError = true;
    agregarLog("[SHEETS] Configurá la URL del Apps Script desde la página local.");
    enviandoAhora = false;
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    if (!conectarWiFi()) {
      ultimoEstadoHTTP = "Fallo WiFi";
      enviandoAhora = false;
      syncGoogleError = true;
      if (!modoAP) activarModoAP();
      return;
    }
  }

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  
  String url = serverUrl + "?";
  url += "temperatura=" + String(tempActual, 1);
  url += "&humedad="    + String(humActual, 1);
  url += "&presion="    + String(presActual, 1);
  url += "&luz="        + String(luzActual);
  url += "&lluvia="     + String(lluviaActual);
  url += "&ip="         + ipGuardada;

  if (http.begin(client, url)) {
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
    http.setTimeout(15000);

    int httpCode = http.GET();
    if (httpCode > 0) {
      ultimoEstadoHTTP = "OK (" + String(httpCode) + ")";
      syncGoogleError = false;
    } else {
      ultimoEstadoHTTP = "Error (" + String(httpCode) + ")";
      syncGoogleError = true;
    }
    http.end();
  } else {
    ultimoEstadoHTTP = "Error HTTP";
    syncGoogleError = true;
  }
  enviandoAhora = false;
}

bool leerConfiguracionRemota(int &minutos, bool &reiniciar) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;

  String url = serverUrl + "?action=obtenerControl&formato=plano";
  if (!http.begin(client, url)) {
    agregarLog("[CONTROL] No se pudo iniciar la consulta a Google Sheets.");
    return false;
  }

  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setTimeout(10000);
  int httpCode = http.GET();
  String respuesta = httpCode > 0 ? http.getString() : "";
  http.end();

  if (httpCode != HTTP_CODE_OK) {
    agregarLog("[CONTROL] Error al consultar Google Sheets: " + String(httpCode));
    return false;
  }

  int separador = respuesta.indexOf('|');
  if (separador <= 0) {
    agregarLog("[CONTROL] Respuesta inválida de Google Sheets.");
    return false;
  }

  int minutosLeidos = respuesta.substring(0, separador).toInt();
  String reinicioLeido = respuesta.substring(separador + 1);
  reinicioLeido.trim();
  if (minutosLeidos < 1 || minutosLeidos > 1440 ||
      (reinicioLeido != "0" && reinicioLeido != "1")) {
    agregarLog("[CONTROL] Intervalo o comando remoto inválido.");
    return false;
  }

  minutos = minutosLeidos;
  reiniciar = reinicioLeido == "1";
  return true;
}

bool confirmarReinicioRemoto() {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;

  String url = serverUrl + "?action=confirmarReinicio";
  if (!http.begin(client, url)) {
    agregarLog("[CONTROL] No se pudo confirmar el reinicio en Google Sheets.");
    return false;
  }

  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setTimeout(10000);
  int httpCode = http.GET();
  String respuesta = httpCode > 0 ? http.getString() : "";
  respuesta.trim();
  http.end();

  if (httpCode != HTTP_CODE_OK || respuesta != "OK") {
    agregarLog("[CONTROL] Google Sheets no confirmó el reinicio.");
    return false;
  }
  return true;
}

void sincronizarConfiguracionRemota() {
  if (WiFi.status() != WL_CONNECTED || !serverUrl.length()) return;

  int minutosRemotos = intervaloMinutos;
  bool reiniciarRemoto = false;
  if (!leerConfiguracionRemota(minutosRemotos, reiniciarRemoto)) return;

  if (minutosRemotos != intervaloMinutos) {
    intervaloMinutos = minutosRemotos;
    INTERVALO_ENVIO = (unsigned long)intervaloMinutos * 60000UL;
    guardarConfigEEPROM(wifiSSID, wifiPass, intervaloMinutos, serverUrl);
    ultimoEnvio = millis();
    agregarLog("[CONTROL] Intervalo actualizado desde Google Sheets: " +
               String(intervaloMinutos) + " min.");
  }

  if (reiniciarRemoto) {
    if (confirmarReinicioRemoto()) {
      agregarLog("[CONTROL] Reinicio remoto confirmado. Reiniciando estación...");
      delay(300);
      ESP.restart();
    }
    agregarLog("[CONTROL] No se ejecutó el reinicio; se volverá a consultar.");
  }
}

void actualizarEstadoLED() {
  unsigned long actual = millis();
  if (enviandoAhora) {
    if (actual - anteriorMillisLED >= 150) {
      anteriorMillisLED = actual;
      estadoLedIntermitente = !estadoLedIntermitente;
      if (estadoLedIntermitente) encenderVerde(); else apagarLEDs();
    }
    return;
  }
  if (modoAP) {
    if (actual - anteriorMillisLED >= 500) {
      anteriorMillisLED = actual;
      alternadorAP = !alternadorAP;
      if (alternadorAP) encenderRojo(); else encenderAzul();
    }
    return;
  }
  if (!bme280_ok) {
    if (actual - anteriorMillisLED >= 1000) {
      anteriorMillisLED = actual;
      estadoLedIntermitente = !estadoLedIntermitente;
      if (estadoLedIntermitente) encenderRojo(); else apagarLEDs();
    }
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    if (actual - anteriorMillisLED >= 200) {
      anteriorMillisLED = actual;
      estadoLedIntermitente = !estadoLedIntermitente;
      if (estadoLedIntermitente) encenderRojo(); else apagarLEDs();
    }
    return;
  }
  if (syncGoogleError) {
    encenderRojo();
    return;
  }
  if (actual - anteriorMillisLED >= 1000) {
    anteriorMillisLED = actual;
    estadoLedIntermitente = !estadoLedIntermitente;
  }
  if (estadoLedIntermitente) {
    if (actual - anteriorMillisLED < 200) encenderAzul(); else apagarLEDs();
  } else {
    apagarLEDs();
  }
}

void configurarServidorWeb() {
  server.on("/", HTTP_GET, []() {
    File file = LittleFS.open("/index.html", "r");
    if (!file) {
      server.send(500, "text/plain", "Error: No se encuentra /index.html en LittleFS.");
      return;
    }
    server.streamFile(file, "text/html");
    file.close();
  });

  server.on("/api/status", HTTP_GET, []() {
    leerSensores();
    String logsEscapados = historialLogs;
    logsEscapados.replace("\\", "\\\\"); logsEscapados.replace("\"", "\\\""); logsEscapados.replace("\n", "\\n");

    String json = "{";
    json += "\"modoAP\":"       + String(modoAP ? "true" : "false") + ",";
    json += "\"ssid\":\""       + wifiSSID + "\",";
    json += "\"serverUrl\":\""  + serverUrl + "\",";
    json += "\"intervalo\":"    + String(intervaloMinutos) + ","; // Enviamos el intervalo actual a la web
    json += "\"rssi\":"         + String(WiFi.RSSI()) + ",";
    json += "\"ipActual\":\""   + (modoAP ? WiFi.softAPIP().toString() : WiFi.localIP().toString()) + "\",";
    json += "\"ipGuardada\":\"" + ipGuardada + "\",";
    json += "\"ultimoHttp\":\"" + ultimoEstadoHTTP + "\",";
    json += "\"bmeOk\":"        + String(bme280_ok ? "true" : "false") + ",";
    json += "\"bhOk\":"         + String(bh1750_ok ? "true" : "false") + ",";
    json += "\"temp\":"         + String(tempActual, 1) + ",";
    json += "\"hum\":"          + String(humActual, 1) + ",";
    json += "\"pres\":"         + String(presActual, 1) + ",";
    json += "\"luz\":"          + String(luzActual) + ",";
    json += "\"lluvia\":"       + String(lluviaActual) + ",";
    json += "\"logs\":\""       + logsEscapados + "\"";
    json += "}";

    server.send(200, "application/json", json);
  });

  // Endpoint para guardar Wi-Fi manteniendo el intervalo actual
  server.on("/api/wifi", HTTP_POST, []() {
    if (server.hasArg("ssid")) {
      String nuevoSsid = server.arg("ssid");
      String nuevoPass = server.arg("pass");
      guardarConfigEEPROM(nuevoSsid, nuevoPass, intervaloMinutos, serverUrl);
      server.send(200, "text/plain", "OK");
      delay(1000);
      ESP.restart();
    } else {
      server.send(400, "text/plain", "Falta SSID");
    }
  });

  server.on("/api/server", HTTP_POST, []() {
    if (!server.hasArg("url")) {
      server.send(400, "text/plain", "Falta la URL del Apps Script");
      return;
    }

    String nuevaUrl = server.arg("url");
    nuevaUrl.trim();
    if (!esUrlAppsScriptValida(nuevaUrl)) {
      server.send(400, "text/plain",
                  "La URL debe ser HTTPS, de script.google.com y terminar en /exec.");
      return;
    }

    serverUrl = nuevaUrl;
    guardarConfigEEPROM(wifiSSID, wifiPass, intervaloMinutos, serverUrl);
    server.send(200, "text/plain", "OK");
    delay(500);
    ESP.restart();
  });

  // El intervalo se administra en Google Sheets para mantener una sola fuente de verdad.
  server.on("/api/intervalo", HTTP_POST, []() {
    server.send(409, "text/plain", "Configure el intervalo en la pestaña Control de Google Sheets.");
  });

  server.on("/api/restart", HTTP_POST, []() {
    server.send(200, "text/plain", "Reiniciando...");
    delay(500);
    ESP.restart();
  });

  server.on("/api/send", HTTP_GET, []() {
    server.send(200, "text/plain", "Enviando...");
    enviarDatos();
    ultimoEnvio = millis();
  });

  server.begin();
  agregarLog("[WEB] Servidor HTTP iniciado.");
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(PIN_LLUVIA, INPUT_PULLUP);
  pinMode(LED_ROJO, OUTPUT);
  pinMode(LED_VERDE, OUTPUT);
  pinMode(LED_AZUL, OUTPUT);
  apagarLEDs();

  if (!LittleFS.begin()) {
    Serial.println("[LITTLEFS] Error montando LittleFS.");
  }

  cargarConfigEEPROM();
  agregarLog("=== INICIANDO ESTACIÓN METEOROLÓGICA ESP8266 ===");
  
  inicializarSensores();

  if (wifiSSID.length() > 0) {
    if (!conectarWiFi()) {
      delay(2000);
      if (!conectarWiFi()) {
        activarModoAP();
      }
    }
  } else {
    agregarLog("[WIFI] Sin credenciales guardadas; iniciando portal de configuración.");
    activarModoAP();
  }

  configurarServidorWeb();

  if (!modoAP) {
    sincronizarConfiguracionRemota();
    ultimoChequeoConfiguracion = millis();
    enviarDatos();
    ultimoEnvio = millis();
  } else {
    ultimoChequeoConfiguracion = millis();
  }
}

void loop() {
  server.handleClient();
  actualizarEstadoLED();

  if (WiFi.status() == WL_CONNECTED &&
      millis() - ultimoChequeoConfiguracion >= 60000UL) {
    ultimoChequeoConfiguracion = millis();
    sincronizarConfiguracionRemota();
  }

  if (millis() - ultimoEnvio >= INTERVALO_ENVIO) {
    ultimoEnvio = millis();
    agregarLog("[LOOP] Intervalo cumplido (" + String(intervaloMinutos) + " min). Enviando datos...");
    
    if (modoAP) {
      if (conectarWiFi()) enviarDatos();
    } else {
      enviarDatos();
    }
  }
}