import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

const splash = document.getElementById("startup-splash");
const splashBarFill = document.getElementById("startup-bar-fill") as HTMLDivElement | null;

let progress = 14;
let splashTimer: number | null = null;
if (splashBarFill) {
  splashBarFill.style.width = `${progress}%`;
  splashTimer = window.setInterval(() => {
    progress = Math.min(92, progress + Math.max(2, Math.floor((92 - progress) / 5)));
    splashBarFill.style.width = `${progress}%`;
    if (progress >= 92 && splashTimer !== null) {
      window.clearInterval(splashTimer);
      splashTimer = null;
    }
  }, 110);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

window.setTimeout(() => {
  if (splashTimer !== null) {
    window.clearInterval(splashTimer);
    splashTimer = null;
  }
  if (splashBarFill) {
    splashBarFill.style.width = "100%";
  }
  if (splash) {
    splash.classList.add("is-hiding");
    window.setTimeout(() => splash.remove(), 300);
  }
}, 220);
