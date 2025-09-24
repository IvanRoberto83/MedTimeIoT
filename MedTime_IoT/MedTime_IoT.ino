#include <WiFi.h>
#include <PubSubClient.h>
#include <DFRobotDFPlayerMini.h>

// WiFi
const char *ssid = "FINS";
const char *password = "30282215";

// MQTT Broker
const char *mqtt_broker = "broker.emqx.io";
const char *topic = "pkm/alarm";
const char *mqtt_username = "";
const char *mqtt_password = "";
const int mqtt_port = 1883;

// Pin
#define LED_PIN 14
#define DF_TX 17   // TX ke RX DFPlayer
#define DF_RX 16   // RX ke TX DFPlayer

WiFiClient espClient;
PubSubClient client(espClient);

// DFPlayer
HardwareSerial dfSerial(1); 
DFRobotDFPlayerMini dfPlayer;

bool ledState = false;

void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  Serial.begin(115200);

  // Serial DFPlayer di UART1
  dfSerial.begin(9600, SERIAL_8N1, DF_RX, DF_TX);
  if (!dfPlayer.begin(dfSerial)) {
    Serial.println("❌ Gagal inisialisasi DFPlayer!");
  } else {
    Serial.println("✅ DFPlayer siap!");
    dfPlayer.volume(15);
  }

  // Koneksi WiFi
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.println("🔌 Connecting to WiFi...");
  }
  Serial.println("✅ Connected to WiFi!");

  // Koneksi MQTT
  client.setServer(mqtt_broker, mqtt_port);
  client.setCallback(callback);
  while (!client.connected()) {
    String client_id = "esp32-client-" + String(WiFi.macAddress());
    if (client.connect(client_id.c_str(), mqtt_username, mqtt_password)) {
      Serial.println("✅ Connected to MQTT Broker!");
    } else {
      Serial.print("❌ Failed, rc=");
      Serial.print(client.state());
      delay(2000);
    }
  }

  client.publish(topic, "📨 ESP Ready & Subscribed!");
  client.subscribe(topic);
}

void callback(char *topic, byte *payload, unsigned int length) {
  String msg = "";
  for (int i = 0; i < length; i++) msg += (char)payload[i];

  if (String(topic) == "pkm/alarm") {
    if (msg.indexOf("\"command\":\"ON\"") >= 0) {
      ledState = true;
      digitalWrite(LED_PIN, HIGH);
      Serial.println("💡 LED ON");

      int start = msg.indexOf("\"mp3\":\"") + 7;
      int end = msg.indexOf("\"", start);
      String mp3File = msg.substring(start, end);

      dfPlayer.play(mp3File.toInt());
    } 
    else if (msg.indexOf("\"command\":\"OFF\"") >= 0) {
      ledState = false;
      digitalWrite(LED_PIN, LOW);
      dfPlayer.stop();
    }
  }
}

void loop() {
  client.loop();

  if (ledState && dfPlayer.available()) {
    uint8_t type = dfPlayer.readType();
    if (type == DFPlayerPlayFinished) {
      dfPlayer.play(1);
    }
  }
}