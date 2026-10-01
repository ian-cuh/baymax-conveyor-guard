#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <math.h>

const int PROX_PIN = 18;
const int LED_PIN = 2;
const int BUZZER_PIN = 8;

Adafruit_MPU6050 mpu;

volatile unsigned long pulseCounter = 0;

float baselineVibration = 9.8;
const float VIBRATION_THRESHOLD = 4.0;

int anomalyCount = 0;
const int CONFIRM_TICKS = 2;

unsigned long lastSpeedCalcTime = 0;
float currentRPM = 0;

void onPulse() {
  pulseCounter++;
}

void autoCalibrate(int seconds) {
  Serial.println("Starting calibration...");
  Serial.println("Keep the conveyor running normally.");

  float vibSum = 0;
  int samples = 0;
  unsigned long startTime = millis();

  while (millis() - startTime < seconds * 1000UL) {
    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);

    float magnitude = sqrt(
      a.acceleration.x * a.acceleration.x +
      a.acceleration.y * a.acceleration.y +
      a.acceleration.z * a.acceleration.z
    );

    vibSum += magnitude;
    samples++;

    delay(50);
  }

  if (samples > 0) {
    baselineVibration = vibSum / samples;
  }

  Serial.print("Baseline vibration: ");
  Serial.println(baselineVibration);
}

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(PROX_PIN, INPUT_PULLUP);

  digitalWrite(LED_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  Wire.begin(21, 22);

  if (!mpu.begin()) {
    Serial.println("MPU6050 not found! Check wiring.");

    while (1) {
      digitalWrite(LED_PIN, !digitalRead(LED_PIN));
      delay(200);
    }
  }

  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);

  Serial.println("MPU6050 initialized.");

  attachInterrupt(
    digitalPinToInterrupt(PROX_PIN),
    onPulse,
    FALLING
  );

  Serial.println("LM393 speed sensor ready.");

  autoCalibrate(4);
}

void loop() {
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);

  float magnitude = sqrt(
    a.acceleration.x * a.acceleration.x +
    a.acceleration.y * a.acceleration.y +
    a.acceleration.z * a.acceleration.z
  );

  float vibrationDelta = fabs(
    magnitude - baselineVibration
  );

  if (millis() - lastSpeedCalcTime >= 1000) {
    noInterrupts();
    unsigned long pulses = pulseCounter;
    pulseCounter = 0;
    interrupts();

    currentRPM = pulses * 60.0;
    lastSpeedCalcTime = millis();
  }

  bool vibrationAnomaly =
    vibrationDelta > VIBRATION_THRESHOLD;

  if (vibrationAnomaly) {
    anomalyCount++;
  } else {
    anomalyCount = max(0, anomalyCount - 1);
  }

  bool alertActive = anomalyCount >= CONFIRM_TICKS;

  digitalWrite(LED_PIN, alertActive ? HIGH : LOW);
  digitalWrite(BUZZER_PIN, alertActive ? HIGH : LOW);

  Serial.print("Vibration: ");
  Serial.print(magnitude, 2);

  Serial.print(" | Delta: ");
  Serial.print(vibrationDelta, 2);

  Serial.print(" | RPM: ");
  Serial.print(currentRPM, 0);

  Serial.print(" | Status: ");
  Serial.println(
    alertActive ? "ANOMALY DETECTED" : "Normal"
  );

  delay(100);
}
