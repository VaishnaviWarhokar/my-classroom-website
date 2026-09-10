# ESP32 integration — PIR + PIR + Temperature

## Sensor write node

Write to `classrooms/E009/sensors`:

```json
{
  "pir1": true,
  "pir2": false,
  "temperature": 28.2,
  "updatedAt": 1750000000000
}
```

`pir1` and `pir2` are the two PIR motion inputs. Temperature is display-only and does not control relays.

## Appliance command node

Listen for web-app writes at `classrooms/E009/appliances`:

```json
{
  "relay1": true,
  "relay2": true,
  "relay3": true,
  "relay4": true,
  "mode": "auto",
  "updatedAt": 1750000000000,
  "controlledBy": "..."
}
```

Map relay1–relay4 to the four physical relay inputs.

## Automatic behavior

1. PIR 1 and PIR 2 are sampled independently every 1.5 seconds; three consecutive TRUE samples trigger their respective relay pair for 30 seconds.
2. During that 30-second period, the triggered PIR is checked at 25.5 seconds, 20 seconds, and exactly 1.5 seconds before expiry. If all three continuation checks are TRUE, its relay pair remains continuously ON.
3. PIR1 and PIR2 state machines are independent, so their timers and continuous-ON states may overlap.
2. Temperature is checked.
3. If temperature is above the app threshold, all four appliances turn ON.
4. They remain ON for 15 minutes.
5. At 15 minutes, occupancy and temperature are checked again.
6. If both conditions remain true, another 15-minute cycle starts. Otherwise all appliances turn OFF.
7. If the sensor timestamp is stale/offline, automatic appliances are forced OFF by the app.

The ESP32 should continue publishing `updatedAt` frequently enough to remain online.


Sensor setup: 2 PIR sensors + 1 temperature sensor. The ultrasonic sensor is removed. Firebase time strings use HH-MM-SS.
