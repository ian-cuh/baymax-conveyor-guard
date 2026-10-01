# Smart Conveyor Guard — Real Hardware Setup (ESP32)

This runs on **real sensors** now: MPU6050 (vibration), HX711 + strain gauge
(tension), IR proximity sensor (speed). No simulator, no temperature sensor
in this build — everything below is for your actual ESP32 board.

## Part A — One-time: get the backend + dashboard running (Docker)

If you already have Docker Desktop installed and this project working from
before, skip to Part B. Otherwise:

1. Install Docker Desktop from docker.com, drag it to Applications, open it,
   wait for the whale icon in your menu bar to stop animating.
2. Unzip this project, open the folder in VS Code.
3. In VS Code's terminal (`` Control+` ``):
```bash
docker compose down
docker system prune -f
docker compose up --build
```
4. Wait for `Uvicorn running on http://0.0.0.0:8000` and
   `Local: http://localhost:5173/` to appear. Leave this running.
5. Open **http://localhost:5173** — dashboard loads, but shows nothing yet
   because no sensor data has arrived. That's expected until Part C.

## Part B — Find your laptop's local IP address

Your ESP32 needs to know where to send data. Open a **new terminal tab**:
```bash
ipconfig getifaddr en0
```
If that returns nothing, try:
```bash
ipconfig getifaddr en1
```
You'll get something like `192.168.1.42`. **Write this down** — you'll paste
it into the Arduino code as `MQTT_HOST`. This only works if your ESP32 and
your Mac are on the **same WiFi network**.

## Part C — Install the Arduino IDE and set up ESP32 support

1. Download the Arduino IDE from **https://www.arduino.cc/en/software** (get
   the Mac version) and install it like any other Mac app.
2. Open Arduino IDE.
3. Go to **Arduino IDE → Settings...** (or **File → Preferences** on some
   versions).
4. Find the field **"Additional Boards Manager URLs"** and paste this in:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
   Click **OK**.
5. Go to **Tools → Board → Boards Manager...**
6. Search for **esp32** (by Espressif Systems). Click **Install**. This
   takes a few minutes.
7. Once installed, go to **Tools → Board → esp32** and select your specific
   board (commonly **"ESP32 Dev Module"** — if unsure, this is usually
   correct for generic ESP32 boards).

## Part D — Install the required libraries

Go to **Tools → Manage Libraries...** (or the library icon in the left
sidebar). Search for and install each of these — click the entry, click
**Install**, and if it asks about installing dependencies, click
**Install All**:

1. **PubSubClient** by Nick O'Leary
2. **Adafruit MPU6050** by Adafruit
3. **Adafruit Unified Sensor** by Adafruit
4. **HX711** by bogde

## Part E — Wire up the sensors

Power off your ESP32 before wiring anything.

**MPU6050** (vibration sensor, connects via I2C):
| MPU6050 pin | ESP32 pin |
|---|---|
| VCC | 3.3V |
| GND | GND |
| SCL | GPIO 22 |
| SDA | GPIO 21 |

**HX711 + strain gauge** (tension sensor):
| HX711 pin | ESP32 pin |
|---|---|
| VCC | 3.3V or 5V (check your module) |
| GND | GND |
| DT | GPIO 16 |
| SCK | GPIO 4 |

**IR proximity sensor** (speed sensor):
| Sensor pin | ESP32 pin |
|---|---|
| VCC | 5V (check your module's rating) |
| GND | GND |
| OUT | GPIO 27 |

Double-check each connection before powering on — a wrong VCC voltage can
damage a sensor.

## Part F — Configure and upload the firmware

1. In VS Code (or Finder), open `firmware/esp32_conveyor_node.ino` —
   double-clicking it should also open Arduino IDE directly.
2. Near the top, edit these four lines with your actual values:
```cpp
#define JOINT_ID        "J1"                  // use "J1" for your first board
const char* WIFI_SSID   = "YOUR_WIFI_SSID";     // your WiFi name
const char* WIFI_PASS   = "YOUR_WIFI_PASSWORD"; // your WiFi password
const char* MQTT_HOST   = "192.168.1.50";       // the IP you found in Part B
```
3. Connect your ESP32 to your Mac with a USB cable.
4. In Arduino IDE: **Tools → Port**, select the port that appears (something
   like `/dev/cu.usbserial-XXXX` or `/dev/cu.SLAB_USBtoUART`). If nothing
   shows up, you may need the CP210x or CH340 USB driver — search "CP2102
   driver mac" or "CH340 driver mac" depending on your board, download and
   install it, then unplug/replug the ESP32.
5. Click the **Upload** button (the right-arrow icon, top-left of the
   Arduino IDE window). Wait for "Done uploading."
6. Open **Tools → Serial Monitor**, set the baud rate (bottom-right dropdown)
   to **115200**. You should see:
```
Connecting to WiFi..... connected: 192.168.1.87
Connecting to MQTT broker... connected
MPU6050 ready
HX711 ready (tared to zero)
IR proximity sensor ready
Setup complete. Publishing readings every second...
{"joint_id":"J1","vibration_g":0.15,"tension_kn":4.32,"speed_mps":0.00}
```
If you see repeated "failed, rc=..." for MQTT, double-check `MQTT_HOST` is
correct and `docker compose up` is still running on your Mac.

## Part G — Confirm it's reaching the dashboard

1. Open **http://localhost:5173** in your browser (use a private/incognito
   window if you've had this open before, to avoid a stale cached version).
2. Joint 1's card should start updating with real health/status.
3. Tap the joint anywhere on the belt, or gently shake the MPU6050 — you
   should see vibration rise on the dashboard within ~1 second.
4. Squeeze/press the load cell — tension should change.
5. Wave something past the IR sensor repeatedly — speed should register.

If nothing updates, check the Serial Monitor is still printing values, and
run this on your Mac to confirm the backend is receiving them:
```bash
curl http://localhost:8000/api/joints
```

## Calibrating the HX711 (important for real tension numbers)

The `TENSION_CALIBRATION` value in the firmware is a starting guess, not
accurate for your specific load cell. To calibrate:
1. With nothing on the load cell, upload the firmware — `scale.tare()` zeros
   it automatically at startup.
2. Place a **known weight** on the load cell (e.g. a 1kg object).
3. Open the Serial Monitor and note the raw reading.
4. Adjust `TENSION_CALIBRATION` so that reading matches the known weight,
   re-upload, and repeat with a different known weight to confirm.

## Adding more joints (J2, J3...)

Repeat Parts E–F with a second/third ESP32, changing only `#define JOINT_ID`
to `"J2"`, `"J3"`, etc. Each board publishes to its own MQTT topic
automatically, and the dashboard already has cards for J1–J3.

## How alerts and precautions work now

The backend (`backend/main.py`) runs a real rule engine against your live
sensor values — not canned demo text. Each rule has a specific, actionable
precaution:
- **Vibration critical/warning** → inspect idler rollers/alignment
- **Tension too low** → check tensioner and splice for slippage
- **Temperature critical/warning** → only fires if you add a temperature
  sensor later; currently skipped since `temperature_c` is optional

Alerts open automatically when a rule triggers, and **auto-resolve** when
the reading returns to normal — this is real state, not a canned "Resolved"
list. The dashboard's Alerts panel (Recent/Resolved tabs) is now live-wired
to `GET /api/alerts?status=open` and `?status=resolved`, plus real-time
`alert_opened`/`alert_resolved` events over the WebSocket.

## Common problems

| Problem | Fix |
|---|---|
| Arduino IDE doesn't see the ESP32 port | Install CP210x or CH340 USB driver for your board, then unplug/replug |
| "failed, rc=-2" or similar MQTT error | Wrong `MQTT_HOST` IP, or ESP32/Mac on different WiFi networks |
| Vibration always reads ~1.0 with no change | MPU6050 wiring issue — double check SDA/SCL aren't swapped |
| Tension reads a huge or negative number | Needs calibration — see above, and check load cell wiring polarity |
| Speed always 0 | IR sensor needs something passing in front of it repeatedly to generate pulses; check OUT pin wiring |
| Dashboard blank even though Serial Monitor shows data | `docker compose` isn't running, or `MQTT_HOST` doesn't match your Mac's current IP (it can change between WiFi sessions — recheck with `ipconfig getifaddr en0`) |

## Scripted demos for screen recording (one belt round = 8 seconds; demos run ~20-44s)

With `docker compose up --build` running and the dashboard open at http://localhost:5173:

```bash
./demo.sh 1      # quiet run, a few vibration blips, then "Temperature rising" warning
./demo.sh 2      # tear spotted -> re-checked over 3 rounds -> confirmed -> belt STOPS + alert
./demo.sh 3      # small tear (warning, keeps running) -> next round ~16x bigger -> belt STOPS
./demo.sh 4      # bonus: tear spotted but gone on re-check -> false alarm, keeps running
./demo.sh reset  # clear everything back to normal between takes
./demo.sh 2 3    # add a 3-second lead-in so you can switch windows before it starts
```

Each demo wipes the previous one automatically, so you can run them back to back.
The dashboard's **Belt Inspection** card shows the round number, verification progress
and tear-size growth; alerts appear in the Recent panel; a stop turns the card red.
