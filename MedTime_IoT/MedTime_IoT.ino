#include <WiFi.h>
#include <WiFiMulti.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// Audio libraries
#include "AudioFileSourceHTTPStream.h"
#include "AudioGeneratorMP3.h"
#include "AudioOutputI2S.h"
#include "AudioFileSourceBuffer.h"
#include "driver/adc.h"

// WiFi
WiFiMulti wifiMulti;

// MQTT Broker
const char *mqtt_broker = "broker.emqx.io";
const char *topic = "pkm/alarm";
const char *mqtt_username = "";
const char *mqtt_password = "";
const int mqtt_port = 1883;

// Pin
#define LED_PIN 14
#define POT_PIN 32

WiFiClient espClient;
PubSubClient client(espClient);

// Audio objects
AudioGeneratorMP3 *mp3;
AudioFileSourceHTTPStream *file = nullptr;
AudioFileSourceBuffer *buff = nullptr;
AudioOutputI2S *out;

String lastUrl = "";   // simpan URL terakhir
bool loopActive = false; // flag looping

unsigned long playStartTime = 0;   // waktu mulai play
const unsigned long LOOP_LIMIT = 60000; // 1 menit

// ==== Safe delete fungsi
void safeDeleteAudio() {
  if (mp3->isRunning()) mp3->stop();
  if (buff) { delete buff; buff = nullptr; }
  if (file) { delete file; file = nullptr; }
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  pinMode(POT_PIN, INPUT);
  digitalWrite(LED_PIN, LOW);
  Serial.begin(115200);

  // ADC NG driver setup
  adc1_config_width(ADC_WIDTH_BIT_12);
  adc1_config_channel_atten(ADC1_CHANNEL_4, ADC_ATTEN_DB_11); // pin 32

  // WiFi connect
  wifiMulti.addAP("YOUR_WIFI", "YOUR_PASSWORD");

  while (wifiMulti.run() != WL_CONNECTED) {
      delay(500);
      Serial.println("🔌 Mencoba semua WiFi...");
  }

  Serial.println("✅ Terhubung ke WiFi: " + WiFi.SSID());

  // MQTT
  client.setServer(mqtt_broker, mqtt_port);
  client.setCallback(callback);
  client.setBufferSize(1024);   // buffer besar buat JSON

  while (!client.connected()) {
    String client_id = "esp32-client-" + String(WiFi.macAddress());
    if (client.connect(client_id.c_str(), mqtt_username, mqtt_password)) {
      Serial.println("✅ Connected to MQTT Broker!");
    } else {
      Serial.print("❌ Failed, rc=");
      Serial.println(client.state());
      delay(2000);
    }
  }
  client.publish(topic, "📨 ESP Ready & Subscribed!");
  client.subscribe(topic);

  // Init audio
  out = new AudioOutputI2S();
  out->SetPinout(27, 26, 25); // BCLK, LRCLK, DIN
  out->SetGain(0.5);          // default volume
  mp3 = new AudioGeneratorMP3();
}

// Callback MQTT
void callback(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (int i = 0; i < length; i++) msg += (char)payload[i];
  Serial.println("📩 Pesan MQTT: " + msg);

  if (String(topic) != "pkm/alarm") return;

  StaticJsonDocument<1024> doc;
  if (deserializeJson(doc, msg)) {
    Serial.println("❌ JSON parse gagal!");
    return;
  }

  const char* command = doc["command"];
  const char* url = doc["mp3Url"];

  if (command && String(command) == "ON") {
    digitalWrite(LED_PIN, HIGH);
    Serial.println("💡 LED ON");

    if (url) {
      lastUrl = String(url);
      loopActive = true;
      playStartTime = millis();
      Serial.println("🔗 URL yang diputar: " + lastUrl);

      safeDeleteAudio();
      file = new AudioFileSourceHTTPStream(lastUrl.c_str());
      buff = new AudioFileSourceBuffer(file, 2048);
      mp3->begin(buff, out);
      Serial.println("▶️ MP3 started (looping ON)");
    }
  }

  if (command && String(command) == "OFF") {
    digitalWrite(LED_PIN, LOW);
    Serial.println("💡 LED OFF");

    loopActive = false;
    safeDeleteAudio();
  }
}

void loop() {
  client.loop();

  // Update volume hanya saat MP3 jalan
  if (mp3->isRunning()) {
    int potValue = adc1_get_raw(ADC1_CHANNEL_4);
    float volume = (float)potValue / 4095.0;
    out->SetGain(volume);

    if (loopActive && millis() - playStartTime >= LOOP_LIMIT) {
      Serial.println("⏳ Batas 1 menit tercapai, audio stop otomatis.");
      loopActive = false;
      safeDeleteAudio();
      digitalWrite(LED_PIN, LOW);
      return;
    }

    // jika playback selesai
    if (!mp3->loop()) {
      mp3->stop();

      // restart hanya jika masih di dalam batas waktu
      if (loopActive && millis() - playStartTime < LOOP_LIMIT) {
        safeDeleteAudio();
        file = new AudioFileSourceHTTPStream(lastUrl.c_str());
        buff = new AudioFileSourceBuffer(file, 2048);
        mp3->begin(buff, out);
      } else {
        loopActive = false;
        safeDeleteAudio();
        digitalWrite(LED_PIN, LOW);
      }
    }
  }

  delay(1); // mencegah watchdog reset
}