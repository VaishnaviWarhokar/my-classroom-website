import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-database.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDM1dLU8x2fYfbgAhvFmf9hi5Wc1TJlPaM",
  authDomain: "smart-classroom-4b847.firebaseapp.com",
  databaseURL: "https://smart-classroom-4b847-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "smart-classroom-4b847",
  storageBucket: "smart-classroom-4b847.firebasestorage.app",
  messagingSenderId: "1033430425011",
  appId: "1:1033430425011:web:1e935fb7027c06396e7fc6",
  measurementId: "G-5PRXKGPRN2"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app, firebaseConfig.databaseURL);
const auth = getAuth(app);

export { app, db, auth };
