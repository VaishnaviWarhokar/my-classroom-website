import time
from datetime import datetime
import firebase_admin
from firebase_admin import credentials, db

SERVICE_ACCOUNT_FILE = "serviceAccountKey.json"
DATABASE_URL = "https://smart-classroom-4b847-default-rtdb.asia-southeast1.firebasedatabase.app"
PATH = "classrooms/E009/sensors"

firebase_admin.initialize_app(
    credentials.Certificate(SERVICE_ACCOUNT_FILE),
    {"databaseURL": DATABASE_URL}
)

pir1 = False
pir2 = False
temperature = 25.0

def send():
    data = {
        "pir1": pir1,
        "pir2": pir2,
        "temperature": round(temperature, 1),
        "updatedAt": int(time.time() * 1000),
        "lastUpdate": datetime.now().strftime("%H-%M-%S")
    }
    db.reference(PATH).set(data)
    print(
        f"[{datetime.now():%H-%M-%S}] "
        f"PIR1={'ON' if pir1 else 'OFF'} PIR2={'ON' if pir2 else 'OFF'} TEMP={temperature:.1f}C"
    )

def menu():
    print("\n1 PIR1 ON   2 PIR1 OFF")
    print("3 PIR2 ON   4 PIR2 OFF")

send()
menu()

while True:
    c = input("Command: ").strip().lower()
    if c == "1":
        pir1 = True; send()
    elif c == "2":
        pir1 = False; send()
    elif c == "3":
        pir2 = True; send()
    elif c == "4":
        pir2 = False; send()
    elif c == "7":
        temperature = 20.0; send()
    elif c == "8":
        temperature = 25.0; send()
    elif c == "9":
        temperature = 30.0; send()
    elif c == "0":
        temperature = 35.0; send()
    elif c == "s":
        send()
    elif c == "q":
        break
    else:
        print("Invalid command")
        menu()
