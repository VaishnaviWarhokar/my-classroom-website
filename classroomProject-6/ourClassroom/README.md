# Smart Classroom — E009 (PIR1 + PIR2)

## Automatic operation

- `pir1` and `pir2` are independent PIR inputs.
- The app samples the latest PIR values every 1.5 seconds.
- Each PIR uses its own finite-state machine and requires 3 consecutive true samples.
- PIR1 true for 3 samples turns ON Relay 1 + Relay 2 for 30 seconds.
- PIR2 true for 3 samples turns ON Relay 3 + Relay 4 for 30 seconds.
- PIR1 and PIR2 timers are independent and may overlap.
- A PIR becoming false after triggering does not cancel its 30-second timer.
- During each 30-second ON period, the same PIR is checked 3 more times: at 25.5 seconds, 20 seconds, and exactly 1.5 seconds before expiry.
- If all 3 continuation checks are TRUE, that relay pair stays continuously ON instead of turning OFF at 30 seconds.
- PIR1 and PIR2 continuation checks and continuous-ON states are independent and may overlap.
- Temperature is display-only and never controls appliances.
- Manual relay switches are always available, whether sensors are online or offline.
- In automatic mode, stale/offline sensor data turns automatic relay pairs OFF.

## Firebase sensors

`classrooms/E009/sensors`

Example:
```json
{
  "pir1": true,
  "pir2": false,
  "temperature": 28.2,
  "updatedAt": 1750000000000
}
```

## Firebase appliance commands

The web app writes commands/state to:
`classrooms/E009/appliances`

Example:
```json
{
  "relay1": true,
  "relay2": true,
  "relay3": true,
  "relay4": true,
  "mode": "auto",
  "updatedAt": 1750000000000,
  "controlledBy": "Occupancy detected + temperature above threshold"
}
```

The ESP32 should listen to this node and physically switch its four relay outputs.

## Logs

Appliance ON/OFF events are stored under:
`classrooms/E009/analytics/applianceLogs`

The dashboard deletes appliance logs and fan analytics older than 24 hours. This is app-side Realtime Database retention; it runs while the dashboard is open. Timestamps are displayed as `HH:MM:SS`.

## Firebase setup

The supplied web Firebase configuration is already placed in `www/js/firebase.js`. Enable Email/Password Authentication and Realtime Database, and deploy the rules from `firebase/database.rules.json`.

Open `www/index.html` using VS Code Live Server or another local web server.

## Sensor simulator

`esp32/sensor_simulator.py` is a Python test sender. Keep `serviceAccountKey.json` beside it and run:
`py sensor_simulator.py`

The simulator writes PIR 1, PIR 2, temperature and `updatedAt` to the same Firebase node used by the dashboard.
