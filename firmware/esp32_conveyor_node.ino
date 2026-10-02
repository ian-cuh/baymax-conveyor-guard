#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_MLX90614.h>
#include "HX711.h"
#include <ArduinoJson.h>

// ===========================
// PIN DEFINITIONS (STANDARD ESP32)
// ===========================
#define I2C_SDA_PIN       21
#define I2C_SCL_PIN       22
#define HX711_DT_PIN      18
#define HX711_SCK_PIN     19
#define IR_SENSOR_PIN      4
#define MOTOR_PWM_PIN     16
#define RELAY_TRIP_PIN     5

#define PWM_CHANNEL        0
#define PWM_FREQ        5000
#define PWM_RES            8

// Wi-Fi Credentials
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

WebServer server(80);

Adafruit_MPU6050 mpu;
Adafruit_MLX90614 mlx = Adafruit_MLX90614();
HX711 scale;

// Global Operational Variables
volatile bool jointTriggered = false;
volatile unsigned long lastInterruptTime = 0;

float currentSpeed = 3.0;
float nominalSpeed = 3.0;
int scanCount = 0;
int systemTier = 0;
String tearMode = "none";
bool awaitingOperator = false;

float telemetryVibration = 0.05;
float telemetryTemp = 32.4;
float telemetryTension = 450.0;
int motorTorque = 140;

// Hardware Interrupt for IR Joint Counter
void IRAM_ATTR isrJointMarker() {
  unsigned long now = millis();
  if (now - lastInterruptTime > 300) { // Software debounce
    jointTriggered = true;
    lastInterruptTime = now;
  }
}

void setMotorSpeed(float mps) {
  currentSpeed = mps;
  int dutyCycle = map((int)(mps * 100), 0, 1000, 0, 255);
  dutyCycle = constrain(dutyCycle, 0, 255);
  ledcWrite(PWM_CHANNEL, dutyCycle);
  motorTorque = (mps <= 0.01) ? 0 : constrain((int)(450 / max(mps * 0.35f, 0.2f)), 0, 480);
}

void triggerEmergencyHalt(const char* logReason) {
  systemTier = 3;
  setMotorSpeed(0.0);
  digitalWrite(RELAY_TRIP_PIN, HIGH); // Trip circuit breaker relay
  awaitingOperator = false;
  Serial.printf("[BAYMAX EMERGENCY HALT]: %s\n", logReason);
}

// REST Endpoint: Deliver real-time telemetry to the dashboard
void handleTelemetry() {
  StaticJsonDocument<512> doc;
  doc["speed"] = currentSpeed;
  doc["vibration"] = telemetryVibration;
  doc["temperature"] = telemetryTemp;
  doc["tension"] = telemetryTension;
  doc["torque"] = motorTorque;
  doc["scanCount"] = scanCount;
  doc["systemTier"] = systemTier;
  doc["tearMode"] = tearMode;
  doc["awaitingApproval"] = awaitingOperator;

  String output;
  serializeJson(doc, output);
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", output);
}

// REST Endpoint: Receive commands from dashboard buttons
void handleCommand() {
  if (server.hasArg("action")) {
    String action = server.arg("action");
    if (action == "start_regular") {
      tearMode = "regular";
      scanCount = 0;
      systemTier = 0;
      awaitingOperator = false;
      digitalWrite(RELAY_TRIP_PIN, LOW);
      setMotorSpeed(nominalSpeed);
    } else if (action == "start_false_alarm") {
      tearMode = "false_alarm";
      scanCount = 0;
      systemTier = 0;
      awaitingOperator = false;
      digitalWrite(RELAY_TRIP_PIN, LOW);
      setMotorSpeed(nominalSpeed);
    } else if (action == "start_growing") {
      tearMode = "growing";
      scanCount = 0;
      systemTier = 0;
      awaitingOperator = false;
      digitalWrite(RELAY_TRIP_PIN, LOW);
      setMotorSpeed(nominalSpeed);
    } else if (action == "confirm_tear") {
      triggerEmergencyHalt("Operator confirmed tear on camera feed");
    } else if (action == "dismiss_tear") {
      tearMode = "none";
      scanCount = 0;
      systemTier = 0;
      awaitingOperator = false;
      setMotorSpeed(nominalSpeed);
    } else if (action == "reset") {
      tearMode = "none";
      scanCount = 0;
      systemTier = 0;
      awaitingOperator = false;
      digitalWrite(RELAY_TRIP_PIN, LOW);
      setMotorSpeed(nominalSpeed);
    }
  }
  if (server.hasArg("speed")) {
    nominalSpeed = server.arg("speed").toFloat();
    if (systemTier == 0 && !awaitingOperator) {
      setMotorSpeed(nominalSpeed);
    }
  }
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "text/plain", "OK");
}

void setup() {
  Serial.begin(115200);

  pinMode(RELAY_TRIP_PIN, OUTPUT);
  digitalWrite(RELAY_TRIP_PIN, LOW);

  pinMode(IR_SENSOR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(IR_SENSOR_PIN), isrJointMarker, FALLING);

  // Motor PWM Configuration
  ledcSetup(PWM_CHANNEL, PWM_FREQ, PWM_RES);
  ledcAttachPin(MOTOR_PWM_PIN, PWM_CHANNEL);
  setMotorSpeed(nominalSpeed);

  // Initialize I2C Bus on GPIO 21 & GPIO 22
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);

  if (!mpu.begin(0x68, &Wire)) {
    Serial.println("Warning: MPU6050 not detected. Continuing...");
  } else {
    mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
  }

  if (!mlx.begin(0x5A, &Wire)) {
    Serial.println("Warning: MLX90614 not detected. Continuing...");
  }

  scale.begin(HX711_DT_PIN, HX711_SCK_PIN);
  scale.set_scale(2280.0f); // Calibration factor
  scale.tare();

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\n[BAYMAX Node Online] IP: %s\n", WiFi.localIP().toString().c_str());

  server.on("/telemetry", HTTP_GET, handleTelemetry);
  server.on("/command", HTTP_GET, handleCommand);
  server.begin();
}

void loop() {
  server.handleClient();

  // Read Sensors
  sensors_event_t a, g, temp;
  if (mpu.getEvent(&a, &g, &temp)) {
    telemetryVibration = sqrt(sq(a.acceleration.x) + sq(a.acceleration.y) + sq(a.acceleration.z)) / 9.81;
  }
  telemetryTemp = mlx.readObjectTempC();
  if (scale.is_ready()) {
    telemetryTension = scale.get_units(1);
  }

  // Handle Multi-Scan Logic triggered by hardware IR sensor
  if (jointTriggered) {
    jointTriggered = false;

    if (tearMode == "false_alarm") {
      scanCount++;
      if (scanCount == 1) {
        setMotorSpeed(0.80); // Decelerate on detection
        awaitingOperator = true;
        systemTier = 2;
      }
    } else if (tearMode == "regular") {
      scanCount++;
      if (scanCount == 1) {
        setMotorSpeed(0.90); // Initial slowdown
        systemTier = 1;
      } else if (scanCount == 2) {
        systemTier = 2;
      } else if (scanCount >= 3) {
        setMotorSpeed(0.20); // Minimum creep speed
        awaitingOperator = true;
        systemTier = 2;
      }
    } else if (tearMode == "growing") {
      scanCount++;
      if (scanCount == 1) {
        setMotorSpeed(0.75);
        systemTier = 1;
      } else if (scanCount >= 2) {
        triggerEmergencyHalt("Fast-trip rapid crack growth detected");
      }
    }
  }

  delay(10);
}
