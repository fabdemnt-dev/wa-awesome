import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBtb74uz6clsoc9uA_AkDHi7DdepEWn2dw",
  authDomain: "wa-awesome.firebaseapp.com",
  projectId: "wa-awesome",
  storageBucket: "wa-awesome.firebasestorage.app",
  messagingSenderId: "1074804319870",
  appId: "1:1074804319870:web:923f0ec866812f98ae5a2f",
  measurementId: "G-DH30YVYB2X"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
