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
    * Registro de datos: Envío automático cada 3 minutos a Google Sheets mediante 
      HTTPS seguro (`WiFiClientSecure` con `setInsecure()` y redirección estricta).
    * Resiliencia de red: Almacenamiento de credenciales WiFi en EEPROM. Si falla 
      la conexión, reintenta y de persistir levanta un portal cautivo AP (192.168.4.1).
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
// CONFIGURACIÓN POR DEFECTO Y GOOGLE SHEETS
// ==========================================
const char* DEFAULT_SSID = "Vilers-2";
const char* DEFAULT_PASS = "Pabada686";
const char* SERVER_URL = "https://script.google.com/macros/s/AKfycbzSYNyQpOOjLdIgsXyUCfpI8I3yZIxtIPF6Gta2JBsch3OCaEKgWJ1RNQimsVy5SZ_9xQ/exec";

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

// Variables de tiempo (se actualizan desde la EEPROM, por defecto 3 minutos)
unsigned long INTERVALO_ENVIO = 180000; // en milisegundos
int intervaloMinutos = 3; 
unsigned long ultimoEnvio = 0;

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

// Funciones EEPROM ampliadas para SSID, Pass e Intervalo (512 bytes totales)
// Estructura EEPROM: [0-31] SSID | [32-63] PASS | [64] Intervalo en Minutos
void guardarConfigEEPROM(String s, String p, int minutos) {
  EEPROM.begin(512);
  for (int i = 0; i < 65; ++i) EEPROM.write(i, 0); // limpiar bloques anteriores
  
  for (unsigned int i = 0; i < s.length() && i < 31; ++i) EEPROM.write(i, s[i]);
  for (unsigned int i = 0; i < p.length() && i < 31; ++i) EEPROM.write(32 + i, p[i]);
  EEPROM.write(64, (uint8_t)minutos);
  
  EEPROM.commit();
  agregarLog("[EEPROM] Configuración guardada (SSID y Minutos: " + String(minutos) + ").");
}

void cargarConfigEEPROM() {
  EEPROM.begin(512);
  char s[32] = {0};
  char p[32] = {0};
  for (int i = 0; i < 32; ++i) s[i] = EEPROM.read(i);
  for (int i = 0; i < 32; ++i) p[i] = EEPROM.read(32 + i);
  uint8_t minGuardados = EEPROM.read(64);

  String readS = String(s);
  String readP = String(p);

  wifiSSID = (readS.length() > 0) ? readS : DEFAULT_SSID;
  wifiPass = (readP.length() > 0) ? readP : DEFAULT_PASS;
  
  if (minGuardados > 0 && minGuardados <= 1440) { // Validar rango coherente (hasta 24 horas)
    intervaloMinutos = minGuardados;
  } else {
    intervaloMinutos = 3; // Valor por defecto
  }
  
  INTERVALO_ENVIO = (unsigned long)intervaloMinutos * 60000UL; // Convertir a milisegundos
  agregarLog("[EEPROM] SSID cargado: " + wifiSSID + " | Intervalo: " + String(intervaloMinutos) + " min");
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
  
  String url = String(SERVER_URL) + "?";
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
      guardarConfigEEPROM(nuevoSsid, nuevoPass, intervaloMinutos);
      server.send(200, "text/plain", "OK");
      delay(1000);
      ESP.restart();
    } else {
      server.send(400, "text/plain", "Falta SSID");
    }
  });

  // NUEVO: Endpoint para cambiar el intervalo de envío en minutos
  server.on("/api/intervalo", HTTP_POST, []() {
    if (server.hasArg("minutos")) {
      int nuevosMin = server.arg("minutos").toInt();
      if (nuevosMin > 0 && nuevosMin <= 1440) {
        guardarConfigEEPROM(wifiSSID, wifiPass, nuevosMin);
        server.send(200, "text/plain", "OK");
        delay(1000);
        ESP.restart();
      } else {
        server.send(400, "text/plain", "Valor inválido (1-1440)");
      }
    } else {
      server.send(400, "text/plain", "Falta argumento");
    }
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

  if (!conectarWiFi()) {
    delay(2000);
    if (!conectarWiFi()) {
      activarModoAP();
    }
  }

  configurarServidorWeb();

  if (!modoAP) {
    enviarDatos();
    ultimoEnvio = millis();
  }
}

void loop() {
  server.handleClient();
  actualizarEstadoLED();

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