import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
  ref, onValue, set, push, update, get, remove
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-database.js";

const CLASSROOM = "E009";
const RELAYS = ["relay1","relay2","relay3","relay4"];
const PIR_SAMPLE_MS = 1500;
const PIR_REQUIRED_SAMPLES = 3;
const RELAY_ON_MS = 30 * 1000;
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

let sensor = {
  pir1:false,
  pir2:false,
  temperature:null,
  updatedAt:0
};
let appliances = {
  relay1:false, relay2:false, relay3:false, relay4:false,
  mode:"auto", updatedAt:0, controlledBy:""
};
let manual = { relay1:false, relay2:false, relay3:false, relay4:false };
let pirFSM = {
  pir1: { state:"IDLE", trueSamples:0, triggeredAt:0, activeChecks:0, activeTrueChecks:0, keepOn:false, nextCheckAt:0 },
  pir2: { state:"IDLE", trueSamples:0, triggeredAt:0, activeChecks:0, activeTrueChecks:0, keepOn:false, nextCheckAt:0 }
};
let activeBooking = null;
let timeoutSeconds = 30;
let fanStateBefore = false;
let fanSession = null;
let analyticsCache = [];
let applianceLogCache = [];
let appliancesInitialized = false;
let previousApplianceState = { relay1:false, relay2:false, relay3:false, relay4:false };

// Automatic PIR cycle: PIR1 and PIR2 are independent and may overlap.
// Temperature is display-only and never controls appliances.

const $ = s => document.querySelector(s);

onAuthStateChanged(auth, user => {
  if(!user){ location.href="./index.html"; return; }
  $("#userLabel").textContent = user.email;
  start();
});

$("#logoutBtn").onclick = () => signOut(auth);

$("#bookingBtn").onclick = () => {
  const dateInput=$("#bookingDate");
  if(dateInput && !dateInput.value){
    const d=new Date();
    d.setMinutes(d.getMinutes()-d.getTimezoneOffset());
    dateInput.value=d.toISOString().slice(0,10);
  }

  const timeInput=$("#bookingStartTime");
  if(timeInput && !timeInput.value){
    const d=new Date(Date.now()+5*60000);
    d.setMinutes(Math.ceil(d.getMinutes()/5)*5);
    timeInput.value=d.toTimeString().slice(0,5);
  }

  updateBookingEndPreview();
  $("#bookingModal").classList.remove("hidden");
};

$("#closeModal").onclick = () => $("#bookingModal").classList.add("hidden");

function updateBookingEndPreview(){
  const date=$("#bookingDate")?.value;
  const startTime=$("#bookingStartTime")?.value;
  const duration=Number($("#bookingDuration")?.value || 0);
  const preview=$("#bookingEndPreview");
  if(!preview) return;

  if(!date || !startTime || !duration){
    preview.textContent="End time will be calculated automatically.";
    return;
  }

  const start=new Date(`${date}T${startTime}`);
  const end=new Date(start.getTime()+duration*60000);
  preview.textContent=`Booking ends at ${formatDateTime(end)}`;
}

$("#bookingDate").onchange=updateBookingEndPreview;
$("#bookingStartTime").oninput=updateBookingEndPreview;
$("#bookingDuration").onchange=updateBookingEndPreview;

$("#autoBtn").onclick = async () => {
  manual = { relay1:false, relay2:false, relay3:false, relay4:false };
  resetPirFSM();
  await set(ref(db, `classrooms/${CLASSROOM}/appliances/mode`), "auto");
  await runPirFSM();
};

RELAYS.forEach(relay => {
  $(`#${relay}Switch`).onchange = async e => {
    manual[relay] = true;
    await writeManualState(relay, e.target.checked);
  };
});

$("#timeoutSeconds").onchange = () => {
  timeoutSeconds = Math.max(10, Number($("#timeoutSeconds").value) || 30);
  renderSensor();
};


$("#bookingForm").onsubmit = async e => {
  e.preventDefault();

  const date = $("#bookingDate").value;
  const startTime = $("#bookingStartTime").value;
  const durationMinutes = Number($("#bookingDuration").value);

  if(!date || !startTime || !durationMinutes){
    $("#bookingMessage").textContent = "Please select the date, start time and duration.";
    return;
  }

  const start = new Date(`${date}T${startTime}`).getTime();
  const end = start + durationMinutes * 60 * 1000;

  if(!start || !end || end <= start){
    $("#bookingMessage").textContent = "Please choose a valid booking time.";
    return;
  }

  const now = Date.now();
  if(start < now){
    $("#bookingMessage").textContent = "Start time cannot be in the past.";
    return;
  }

  const existing = await get(ref(db, "bookings"));
  const bookings = existing.val() || {};
  const conflict = Object.values(bookings).some(b =>
    b.classroom === CLASSROOM &&
    b.active !== false &&
    Number(b.end) > now &&
    start < Number(b.end) &&
    end > Number(b.start)
  );

  if(conflict){
    $("#bookingMessage").textContent = "This classroom is already booked for that period.";
    return;
  }

  const booking = {
    classroom: CLASSROOM,
    purpose: $("#bookingPurpose").value.trim(),
    start,
    end,
    startTime: formatTime(new Date(start)),
    endTime: formatTime(new Date(end)),
    teacher: auth.currentUser.email,
    active: true,
    createdAt: now,
    createdTime: formatDateTime(new Date(now))
  };

  await set(push(ref(db, "bookings")), booking);

  $("#bookingMessage").textContent = "Booking created.";
  setTimeout(() => {
    $("#bookingModal").classList.add("hidden");
    $("#bookingMessage").textContent = "";
  }, 900);

  e.target.reset();
};

function start(){
  onValue(ref(db, `classrooms/${CLASSROOM}/sensors`), snap => {
    const v = snap.val() || {};
    sensor = {
      pir1: Boolean(v.pir1 ?? v.pir ?? v.frontPir ?? false),
      pir2: Boolean(v.pir2 ?? v.rearPir ?? false),
      temperature: Number.isFinite(Number(v.temperature)) ? Number(v.temperature) : null,
      updatedAt: Number(v.updatedAt || 0)
    };
    renderSensor();
  });

  onValue(ref(db, `classrooms/${CLASSROOM}/appliances`), snap => {
    const v = snap.val() || {};
    const incoming = { ...appliances, ...v };
    const controlledBy = incoming.controlledBy || "Unknown";

    if(appliancesInitialized){
      RELAYS.forEach(relay => {
        const oldState = Boolean(previousApplianceState[relay]);
        const newState = Boolean(incoming[relay]);
        if(oldState !== newState){
          logApplianceTransition(relay, newState, controlledBy);
        }
      });
    }

    appliances = incoming;
    previousApplianceState = {
      relay1:Boolean(appliances.relay1),
      relay2:Boolean(appliances.relay2),
      relay3:Boolean(appliances.relay3),
      relay4:Boolean(appliances.relay4)
    };
    appliancesInitialized = true;

    const newFanState = Boolean(appliances.relay2);
    handleFanTransition(newFanState, controlledBy);
    renderAppliances();
  });

  onValue(ref(db, "bookings"), async snap => {
    const data = snap.val() || {};
    const now = Date.now();

    for(const [id,b] of Object.entries(data)){
      if(
        b.classroom === CLASSROOM &&
        b.active !== false &&
        Number(b.end) > 0 &&
        Number(b.end) <= now
      ){
        await update(ref(db, `bookings/${id}`), {
          active:false,
          endedAutomatically:true,
          terminatedAt:now,
          terminatedTime:formatDateTime(new Date(now))
        });
      }
    }

    const monthMs = 30 * 24 * 60 * 60 * 1000;
    for(const [id,b] of Object.entries(data)){
      const basis = Number(b.end || b.createdAt || 0);
      if(basis && now - basis > monthMs){
        await remove(ref(db, `bookings/${id}`));
      }
    }

    const list = Object.entries(data)
      .map(([id,b]) => ({id,...b}))
      .filter(b =>
        b.classroom === CLASSROOM &&
        b.active !== false &&
        Number(b.start) > 0 &&
        Number(b.end) > Number(b.start)
      );

    const current = list
      .filter(b => Number(b.start) <= now && Number(b.end) > now)
      .sort((a,b) => Number(a.end)-Number(b.end))[0];

    const upcoming = list
      .filter(b => Number(b.start) > now)
      .sort((a,b) => Number(a.start)-Number(b.start))[0];

    activeBooking = current || upcoming || null;
    renderBooking();
  });

  onValue(ref(db, `classrooms/${CLASSROOM}/analytics/fanSessions`), snap => {
    analyticsCache = Object.entries(snap.val() || {})
      .map(([id,v]) => ({id,...v}))
      .filter(v => Number(v.startedAt || 0) >= Date.now() - LOG_RETENTION_MS)
      .sort((a,b) => Number(b.startedAt)-Number(a.startedAt));
    renderAnalytics();
  });

  onValue(ref(db, `classrooms/${CLASSROOM}/analytics/applianceLogs`), snap => {
    const cutoff = Date.now() - LOG_RETENTION_MS;
    const raw = snap.val() || {};
    applianceLogCache = Object.entries(raw)
      .map(([id,v]) => ({id,...v}))
      .filter(v => !Number(v.timestamp) || Number(v.timestamp) >= cutoff)
      .sort((a,b) => Number(b.timestamp)-Number(a.timestamp));
    renderApplianceLogs();
  });

  setInterval(() => {
    renderSensor();
    checkExpiredBooking();
  }, 1000);

  // Retain app logs/analytics for 24 hours.
  cleanupOldAnalytics();
  setInterval(cleanupOldAnalytics, 60 * 1000);

  // The automatic PIR state machine samples the latest Firebase sensor value
  // every 1.5 seconds. PIR1 and PIR2 have independent, overlapping states.
  setInterval(runPirFSM, PIR_SAMPLE_MS);
}

function sensorFresh(){
  return sensor.updatedAt > 0 &&
    (Date.now() - sensor.updatedAt) <= timeoutSeconds * 1000;
}

function renderSensor(){
  const fresh = sensorFresh();
  const occupied = sensor.pir1 || sensor.pir2;

  $("#occupancy").textContent = occupied ? "Occupied / Motion" : "Vacant";
  $("#pirStatus").textContent =
    `PIR 1: ${sensor.pir1 ? "Motion" : "Clear"} • PIR 2: ${sensor.pir2 ? "Motion" : "Clear"}`;

  $("#temperature").textContent =
    sensor.temperature === null ? "-- °C" : `${sensor.temperature.toFixed(1)} °C`;
  $("#temperatureStatus").textContent =
    sensor.temperature === null ? "No temperature data" : "Display only • does not control appliances";

  $("#sensorStatus").textContent = fresh ? "Online" : "Offline";

  if(sensor.updatedAt){
    const seconds = Math.max(0, Math.floor((Date.now()-sensor.updatedAt)/1000));
    $("#sensorUpdated").textContent = `Updated ${formatElapsed(seconds)} ago`;
  } else {
    $("#sensorUpdated").textContent = "No recent update";
  }

  $("#connectionStatus").textContent = fresh ? "Sensors online" : "Sensors offline";
  $("#relaySummary").textContent =
    `${RELAYS.filter(r => appliances[r]).length} / 4 ON`;
  $("#relayMode").textContent =
    appliances.mode === "manual" ? "Manual control active" :
    `Automatic • PIR1 ${pirFSM.pir1.state} • PIR2 ${pirFSM.pir2.state}`;
}

function formatElapsed(totalSeconds){
  const s = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return `${String(hours).padStart(2,"0")}h ${String(minutes).padStart(2,"0")}m ${String(seconds).padStart(2,"0")}s`;
}

function formatRemaining(endMs){
  return formatElapsed(Math.floor(Math.max(0,endMs-Date.now())/1000));
}

async function runPirFSM(){
  // Manual mode never gets overridden by the PIR state machine.
  if(appliances.mode === "manual") return;

  const fresh = sensorFresh();
  if(!fresh){
    resetPirFSM();
    await setAutomaticPairState("relay1","relay2",false,"Sensors offline");
    await setAutomaticPairState("relay3","relay4",false,"Sensors offline");
    return;
  }

  const now = Date.now();
  await processPir("pir1", sensor.pir1, ["relay1","relay2"], now);
  await processPir("pir2", sensor.pir2, ["relay3","relay4"], now);
}

async function processPir(name, isTrue, relays, now){
  const fsm = pirFSM[name];

  // After the initial 3-sample trigger, run for 30 seconds.
  // Continuation checks happen at 10s, 20s, and exactly 1.5s before expiry.
  // If all three are TRUE, the pair is latched ON continuously.
  if(fsm.state === "ACTIVE"){
    if(fsm.keepOn) return;

    const elapsed = now - fsm.triggeredAt;
    const checkTimes = [10000, 20000, RELAY_ON_MS - PIR_SAMPLE_MS];

    while(
      fsm.activeChecks < checkTimes.length &&
      elapsed >= checkTimes[fsm.activeChecks]
    ){
      fsm.activeChecks += 1;
      if(isTrue) fsm.activeTrueChecks += 1;

      if(fsm.activeChecks === PIR_REQUIRED_SAMPLES){
        if(fsm.activeTrueChecks === PIR_REQUIRED_SAMPLES){
          fsm.keepOn = true;
          fsm.state = "CONTINUOUS";
          await setAutomaticPairState(
            relays[0], relays[1], true,
            `${name.toUpperCase()} all 3 continuation checks TRUE - continuous ON`
          );
        }
      }
    }

    if(
      fsm.state === "ACTIVE" &&
      elapsed >= RELAY_ON_MS
    ){
      fsm.state = "IDLE";
      fsm.trueSamples = 0;
      fsm.triggeredAt = 0;
      fsm.activeChecks = 0;
      fsm.activeTrueChecks = 0;
      fsm.keepOn = false;
      fsm.nextCheckAt = 0;

      await setAutomaticPairState(
        relays[0], relays[1], false,
        `${name.toUpperCase()} 30-second timer complete; continuation checks not all TRUE`
      );
    }
    return;
  }

  // All three continuation checks were TRUE, so this PIR pair remains ON
  // continuously in automatic mode until manual control/reset is selected.
  if(fsm.state === "CONTINUOUS") return;

  if(!isTrue){
    fsm.trueSamples = 0;
    fsm.state = "IDLE";
    return;
  }

  if(fsm.state === "IDLE") fsm.state = "SAMPLING";

  fsm.trueSamples += 1;

  if(fsm.trueSamples >= PIR_REQUIRED_SAMPLES){
    fsm.state = "ACTIVE";
    fsm.triggeredAt = now;
    fsm.activeChecks = 0;
    fsm.activeTrueChecks = 0;
    fsm.keepOn = false;
    fsm.nextCheckAt = now + 10000;

    await setAutomaticPairState(
      relays[0], relays[1], true,
      `${name.toUpperCase()} true for 3 initial samples`
    );
  }
}

async function setAutomaticPairState(relayA, relayB, desired, reason){
  if(appliances.mode === "manual") return;

  const pairNeedsUpdate =
    Boolean(appliances[relayA]) !== desired ||
    Boolean(appliances[relayB]) !== desired ||
    appliances.mode !== "auto";

  if(!pairNeedsUpdate) return;

  // Update only this PIR's relay pair so PIR1 and PIR2 can overlap
  // without one state machine overwriting the other's relays.
  const patch = {
    [relayA]: desired,
    [relayB]: desired,
    mode:"auto",
    updatedAt:Date.now(),
    controlledBy:reason
  };

  await update(ref(db, `classrooms/${CLASSROOM}/appliances`), patch);

  // Keep the local snapshot in sync immediately; the Firebase listener
  // will subsequently confirm the same state.
  appliances[relayA] = desired;
  appliances[relayB] = desired;
  appliances.mode = "auto";
  appliances.updatedAt = patch.updatedAt;
  appliances.controlledBy = reason;
}

function resetPirFSM(){
  pirFSM.pir1 = {
    state:"IDLE", trueSamples:0, triggeredAt:0,
    activeChecks:0, activeTrueChecks:0, keepOn:false, nextCheckAt:0
  };
  pirFSM.pir2 = {
    state:"IDLE", trueSamples:0, triggeredAt:0,
    activeChecks:0, activeTrueChecks:0, keepOn:false, nextCheckAt:0
  };
}

async function writeAutomaticState(){
  resetPirFSM();
  await set(ref(db, `classrooms/${CLASSROOM}/appliances/mode`), "auto");
  await runPirFSM();
}

async function writeManualState(changedRelay, value){
  // Manual control is always available, even when sensors are offline.
  const state = {
    relay1:Boolean(appliances.relay1),
    relay2:Boolean(appliances.relay2),
    relay3:Boolean(appliances.relay3),
    relay4:Boolean(appliances.relay4)
  };

  state[changedRelay] = Boolean(value);
  manual[changedRelay] = Boolean(value);
  resetPirFSM();

  await set(ref(db, `classrooms/${CLASSROOM}/appliances`), {
    ...state,
    mode:"manual",
    updatedAt:Date.now(),
    controlledBy:auth.currentUser.email
  });
}

function renderAppliances(){
  RELAYS.forEach((relay, index) => {
    const n = index + 1;
    $(`#${relay}Switch`).checked = Boolean(appliances[relay]);
    $(`#${relay}Reason`).textContent =
      appliances.mode === "manual" ? "Manual control" :
      (relay === "relay1" || relay === "relay2"
        ? `PIR 1 • ${pirFSM.pir1.state}`
        : `PIR 2 • ${pirFSM.pir2.state}`);
  });

  $("#relaySummary").textContent =
    `${RELAYS.filter(r => appliances[r]).length} / 4 ON`;
  $("#relayMode").textContent =
    appliances.mode === "manual" ? "Manual override active" :
    `Automatic • PIR1 ${pirFSM.pir1.state} • PIR2 ${pirFSM.pir2.state}`;
}

function checkExpiredBooking(){
  if(activeBooking && Number(activeBooking.end) <= Date.now()){
    activeBooking = null;
    renderBooking();
  }
}

function renderBooking(){
  const el = $("#bookingContent");

  if(!activeBooking){
    el.innerHTML = '<div class="empty">No active or upcoming booking.</div>';
    return;
  }

  const now = Date.now();
  const startMs = Number(activeBooking.start);
  const endMs = Number(activeBooking.end);
  const isCurrent = startMs <= now && endMs > now;

  const start = formatDateTime(new Date(startMs));
  const end = formatDateTime(new Date(endMs));

  if(isCurrent){
    const remaining = Math.max(0, Math.floor((endMs-now)/1000));

    el.innerHTML = `
      <div class="booking-active">
        <div>
          <strong>${escapeHtml(activeBooking.purpose || "Classroom booking")}</strong>
          <br>
          <span class="muted">
            ${start} → ${end}<br>
            Booked by ${escapeHtml(activeBooking.teacher || "Unknown")}
          </span>
        </div>
        <div class="booking-actions">
          <span class="countdown">Active • Ends in ${formatElapsed(remaining)}</span>
          <button class="danger" id="terminateBooking">Terminate now</button>
        </div>
      </div>`;

    $("#terminateBooking").onclick = async () => {
      const now = Date.now();
      await update(ref(db, `bookings/${activeBooking.id}`), {
        active:false,
        terminatedAt:now,
        terminatedTime:formatDateTime(new Date(now)),
        terminatedBy:auth.currentUser.email
      });
    };
  }else{
    const untilStart = Math.max(0, Math.floor((startMs-now)/1000));

    el.innerHTML = `
      <div class="booking-active">
        <div>
          <strong>${escapeHtml(activeBooking.purpose || "Classroom booking")}</strong>
          <br>
          <span class="muted">
            ${start} → ${end}<br>
            Booked by ${escapeHtml(activeBooking.teacher || "Unknown")}
          </span>
        </div>
        <div class="booking-actions">
          <span class="countdown">Upcoming • Starts in ${formatElapsed(untilStart)}</span>
          <button class="danger" id="cancelBooking">Cancel booking</button>
        </div>
      </div>`;

    $("#cancelBooking").onclick = async () => {
      if(!confirm("Cancel this booking?")) return;

      const now = Date.now();
      await update(ref(db, `bookings/${activeBooking.id}`), {
        active:false,
        cancelledAt:now,
        cancelledTime:formatDateTime(new Date(now)),
        cancelledBy:auth.currentUser.email
      });
    };
  }
}

async function handleFanTransition(newState, controlledBy){
  if(newState === fanStateBefore) return;

  const now = Date.now();

  if(newState){
    fanSession = {
      startedAt:now,
      startedBy:controlledBy
    };
    fanStateBefore = true;
    return;
  }

  if(fanSession){
    const duration = Math.max(0, now - fanSession.startedAt);

    const session = {
      startedAt:fanSession.startedAt,
      endedAt:now,
      startedTime:formatDateTime(new Date(fanSession.startedAt)),
      endedTime:formatDateTime(new Date(now)),
      durationMs:duration,
      durationTime:formatElapsed(Math.floor(duration/1000)),
      startedBy:fanSession.startedBy || "Unknown",
      endedBy:controlledBy || "Unknown"
    };

    await set(push(ref(db, `classrooms/${CLASSROOM}/analytics/fanSessions`)), session);
    fanSession = null;
  }

  fanStateBefore = false;
}

async function logApplianceTransition(relay, isOn, controlledBy){
  const now = Date.now();
  const relayNames = {
    relay1:"Relay 1 • Light",
    relay2:"Relay 2 • Fan",
    relay3:"Relay 3",
    relay4:"Relay 4"
  };

  const event = {
    relay,
    relayName:relayNames[relay] || relay,
    state:isOn,
    action:isOn ? "ON" : "OFF",
    timestamp:now,
    time:formatTime(new Date(now)),
    dateTime:formatDateTime(new Date(now)),
    controlledBy:controlledBy || "Unknown"
  };

  await set(
    push(ref(db, `classrooms/${CLASSROOM}/analytics/applianceLogs`)),
    event
  );
}

async function cleanupOldAnalytics(){
  const cutoff = Date.now() - LOG_RETENTION_MS;
  const base = `classrooms/${CLASSROOM}/analytics`;

  const [fanSnap, logSnap] = await Promise.all([
    get(ref(db, `${base}/fanSessions`)),
    get(ref(db, `${base}/applianceLogs`))
  ]);

  const tasks = [];
  for(const [id, v] of Object.entries(fanSnap.val() || {})){
    const ts = Number(v.endedAt || v.startedAt || 0);
    if(ts && ts < cutoff) tasks.push(remove(ref(db, `${base}/fanSessions/${id}`)));
  }
  for(const [id, v] of Object.entries(logSnap.val() || {})){
    const ts = Number(v.timestamp || 0);
    if(ts && ts < cutoff) tasks.push(remove(ref(db, `${base}/applianceLogs/${id}`)));
  }

  if(tasks.length) await Promise.all(tasks);
}

function renderAnalytics(){
  const completed = analyticsCache.filter(x => Number(x.durationMs) > 0);
  const totalMs = completed.reduce((sum,x) => sum + Number(x.durationMs || 0), 0);
  const last = completed[0];

  $("#fanAnalytics").innerHTML = `
    <div><strong>${completed.length}</strong><span>sessions</span></div>
    <div><strong>${formatElapsed(Math.floor(totalMs/1000))}</strong><span>total fan time</span></div>
    <div><strong>${last ? escapeHtml(last.startedBy) : "--"}</strong><span>last user / controller</span></div>`;

  if(!completed.length){
    $("#fanLog").innerHTML = '<div class="empty">No completed fan sessions yet.</div>';
    return;
  }

  $("#fanLog").innerHTML = completed.slice(0,10).map(x => `
    <div class="usage-row">
      <div>
        <strong>${escapeHtml(x.startedBy || "Unknown")}</strong>
        <small>
          Start: ${escapeHtml(x.startedTime || formatDateTime(new Date(Number(x.startedAt))))}<br>
          End: ${escapeHtml(x.endedTime || formatDateTime(new Date(Number(x.endedAt))))}
        </small>
      </div>
      <span>${escapeHtml(x.durationTime || formatElapsed(Math.floor(Number(x.durationMs||0)/1000)))}</span>
    </div>
  `).join("");
}

function renderApplianceLogs(){
  const el=$("#applianceLog");

  if(!applianceLogCache.length){
    el.innerHTML='<div class="empty">No appliance ON/OFF events stored yet.</div>';
    return;
  }

  el.innerHTML=applianceLogCache.slice(0,30).map(x => `
    <div class="usage-row">
      <div>
        <strong>${escapeHtml(x.relayName || x.relay || "Appliance")}</strong>
        <small>
          ${escapeHtml(x.action || "")} • ${escapeHtml(x.time || formatTime(new Date(Number(x.timestamp))))}<br>
          ${escapeHtml(x.dateTime || formatDateTime(new Date(Number(x.timestamp))))}<br>
          ${escapeHtml(x.controlledBy || "Unknown")}
        </small>
      </div>
      <span>${escapeHtml(x.action || "--")}</span>
    </div>
  `).join("");
}

function formatTime(date){
  const hh = String(date.getHours()).padStart(2,"0");
  const mm = String(date.getMinutes()).padStart(2,"0");
  const ss = String(date.getSeconds()).padStart(2,"0");
  return `${hh}:${mm}:${ss}`;
}

function formatDateTime(date){
  return `${date.toLocaleDateString()} ${formatTime(date)}`;
}

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g,c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}
