import { auth, db } from "./firebase.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { ref, set } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-database.js";

let register = false;
const form = document.querySelector("#authForm");
const loginTab = document.querySelector("#loginTab");
const registerTab = document.querySelector("#registerTab");
const nameWrap = document.querySelector("#nameWrap");
const submit = document.querySelector("#authSubmit");
const message = document.querySelector("#authMessage");
const forgot = document.querySelector("#forgotPassword");

function setMode(isRegister){
  register = isRegister;
  loginTab.classList.toggle("active", !register);
  registerTab.classList.toggle("active", register);
  nameWrap.classList.toggle("hidden", !register);
  submit.textContent = register ? "Create account" : "Login";
  forgot.classList.toggle("hidden", register);
  message.textContent = "";
}

loginTab.onclick=()=>setMode(false);
registerTab.onclick=()=>setMode(true);

forgot.onclick = async () => {
  const email = document.querySelector("#email").value.trim();
  if (!email) {
    message.textContent = "Enter your email first, then choose Forgot password.";
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    message.textContent = "Password reset email sent. Check your inbox.";
  } catch (err) {
    message.textContent = err.message.replace("Firebase: ","");
  }
};

form.addEventListener("submit", async e=>{
  e.preventDefault();
  message.textContent="Please wait…";
  const email=document.querySelector("#email").value.trim();
  const password=document.querySelector("#password").value;
  const name=document.querySelector("#name").value.trim();

  try{
    if(register){
      const result=await createUserWithEmailAndPassword(auth,email,password);
      await set(ref(db,`users/${result.user.uid}`),{
        name:name||"Teacher",
        email,
        createdAt:Date.now()
      });
    }else{
      await signInWithEmailAndPassword(auth,email,password);
    }
    location.href="./dashboard.html";
  }catch(err){
    message.textContent=err.message.replace("Firebase: ","");
  }
});
