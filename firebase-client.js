import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported, setAnalyticsCollectionEnabled } from "firebase/analytics";

const app = initializeApp({
  apiKey: "AIzaSyAs0sOJNKFIR68vbJOOdYfnr7I0T_bfOTI",
  authDomain: "atm-fod.firebaseapp.com",
  projectId: "atm-fod",
  storageBucket: "atm-fod.firebasestorage.app",
  messagingSenderId: "425523651965",
  appId: "1:425523651965:web:5c07eb8924e1974e8a5814",
  measurementId: "G-0H4ZML79EH"
});

let analyticsInstance = null;

async function enableAnalytics() {
  try {
    if (!(await isSupported())) return false;
    analyticsInstance ??= getAnalytics(app);
    await setAnalyticsCollectionEnabled(analyticsInstance, true);
    return true;
  } catch (error) {
    console.warn("Firebase Analytics is unavailable in this browser.", error);
    return false;
  }
}

function disableAnalytics() {
  if (analyticsInstance) void setAnalyticsCollectionEnabled(analyticsInstance, false);
}

window.atmFirebase = { enableAnalytics, disableAnalytics };
window.dispatchEvent(new Event("atm-firebase-ready"));
