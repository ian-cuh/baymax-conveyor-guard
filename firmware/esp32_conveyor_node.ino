/*
  Smart Conveyor Guard — ESP32 Joint Node
  --------------------------------------------------------------
  Sensors actually wired up on this build:
    - MPU6050              : vibration (accelerometer, RMS in g)
    - HX711 + strain gauge  : belt tension (kN)
    - IR proximity sensor   : belt speed (pulses -> m/s)

  No temperature sensor on this build. temperature_c is simply left out
  of the JSON payload -- the backend already treats it as optional and
  will show "unknown" rather than a fake number. If you add an MLX90614
  later, see the commented-out block near the bottom of loop().

  Publishes one JSON reading per second to:
    conveyor/<JOINT_ID>/telemetry

  ---------------- WIRING ----------------
  MPU6050 (I2C):
    VCC -> 3.3V        GND -> GND
    SCL -> GPIO 22      SDA -> GPIO 21   (ESP32 default I2C pins)

  HX711 (load cell amp):
    VCC -> 3.3V or 5V   GND -> GND
    DT  -> GPIO 16      SCK -> GPIO 4

  IR proximity sensor (digital output, e.g. E18-D80NK or similar):
    VCC -> 5V (check your module's rating)   GND -> GND
    OUT -> GPIO 27  (through the module's own digital output, no extra
                     resistor needed if module has a built-in comparator)

  ---------------- LIBRARIES (Arduino IDE Library Manager) ----------------
    - PubSubClient          by Nick O'Leary        (MQTT)
    - Adafruit MPU6050      by Adafruit
    - Adafruit Unified Sensor  by Adafruit          (MPU6050 dependency)
    - HX711                 by bogde
  WiFi.h and Wire.h are built into the ESP32 board package, nothing to
  install for those.
*/

#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <HX711.h>

// ---------------- CONFIG -- edit these before uploading ----------------
#define JOINT_ID        "J1"                  // change per board: J1, J2, J3 ...
const char* WIFI_SSID   = "YOUR_WIFI_SSID";
const char* WIFI_PASS   = "YOUR_WIFI_PASSWORD";
const char* MQTT_HOST   = "192.168.11.127";      // your laptop's IP (see README)
const int   MQTT_PORT   = 1883;
const unsigned long SAMPLE_INTERVAL_MS = 1000; // 1 reading/sec

// HX711 pins
#define HX711_DOUT 16
#define HX711_SCK  4
// Calibration factor: raw ADC counts per kN. You MUST calibrate this with
// a known weight -- see "Calibrating the HX711" in the README. Using the
// wrong number here means your tension readings will be wrong (but the
// system will still run -- it just won't be accurate until calibrated).
const float TENSION_CALIBRATION = 21000.0;

// IR proximity sensor (digital pulse each time a belt marker passes)
#define PROX_PIN 27
const float MARKER_SPACING_M = 1.0; // distance between two consecutive markers on the belt

// ---------------- GLOBALS ----------------
WiFiClient espClient;
PubSubClient mqtt(espClient);
Adafruit_MPU6050 mpu;
HX711 scale;

volatile unsigned long lastPulseMicros = 0;
volatile float lastSpeedMps = 0;

void IRAM_ATTR onProxPulse() {
  unsigned long now = micros();
  unsigned long dt = now - lastPulseMicros;
  if (dt > 1000) { // debounce -- ignore pulses closer than 1ms apart (electrical noise)
    lastSpeedMps = MARKER_SPACING_M / (dt / 1e6);
    lastPulseMicros = now;
  }
}

void connectWiFi() {
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println(" connected: " + WiFi.localIP().toString());
}

void connectMQTT() {
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  while (!mqtt.connected()) {
    Serial.print("Connecting to MQTT broker...");
    String clientId = "conveyor-" + String(JOINT_ID);
    if (mqtt.connect(clientId.c_str())) {
      Serial.println(" connected");
    } else {
      Serial.print(" failed, rc="); Serial.print(mqtt.state());
      Serial.println(" -- retrying in 1.5s (check MQTT_HOST and that Docker is running)");
      delay(1500);
    }
  }
}

float readVibrationRMS() {
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);
  // Magnitude of the 3 acceleration axes, converted from m/s^2 to g
  float mag = sqrt(a.acceleration.x * a.acceleration.x +
                    a.acceleration.y * a.acceleration.y +
                    a.acceleration.z * a.acceleration.z);
  return mag / 9.80665;
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Wire.begin();

  connectWiFi();
  connectMQTT();

  if (!mpu.begin()) {
    Serial.println("WARNING: MPU6050 not found -- check wiring (SDA=21, SCL=22)");
  } else {
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    Serial.println("MPU6050 ready");
  }

  scale.begin(HX711_DOUT, HX711_SCK);
  scale.set_scale(TENSION_CALIBRATION);
  scale.tare();  // zeroes the reading -- make sure nothing is pressing on the load cell when this runs
  Serial.println("HX711 ready (tared to zero)");

  pinMode(PROX_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PROX_PIN), onProxPulse, FALLING);
  Serial.println("IR proximity sensor ready");

  Serial.println("Setup complete. Publishing readings every second...");
}

void loop() {
  if (!mqtt.connected()) connectMQTT();
  mqtt.loop();

  float vibration_g = readVibrationRMS();
  float tension_kn  = scale.is_ready() ? scale.get_units(5) / 1000.0 : -1;

  // If no pulse in the last 3 seconds, belt is considered stopped (speed = 0)
  float speed_mps = ((millis() / 1000.0) - (lastPulseMicros / 1000000.0) > 3.0) ? 0 : lastSpeedMps;

  char payload[200];
  snprintf(payload, sizeof(payload),
    "{\"joint_id\":\"%s\",\"vibration_g\":%.3f,\"tension_kn\":%.2f,\"speed_mps\":%.2f}",
    JOINT_ID, vibration_g, tension_kn, speed_mps);

  // ---- If you add an MLX90614 temperature sensor later, replace the
  // block above with this one (and #include <Adafruit_MLX90614.h> +
  // Adafruit_MLX90614 mlx; + mlx.begin() in setup()):
  //
  // float temperature_c = mlx.readObjectTempC();
  // snprintf(payload, sizeof(payload),
  //   "{\"joint_id\":\"%s\",\"vibration_g\":%.3f,\"tension_kn\":%.2f,"
  //   "\"temperature_c\":%.1f,\"speed_mps\":%.2f}",
  //   JOINT_ID, vibration_g, tension_kn, temperature_c, speed_mps);

  String topic = String("conveyor/") + JOINT_ID + "/telemetry";
  mqtt.publish(topic.c_str(), payload);

  Serial.println(payload);
  delay(SAMPLE_INTERVAL_MS);
}
