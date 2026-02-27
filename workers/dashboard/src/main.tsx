import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

// Register service worker for PWA support
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js");
  });
}

// Capture the PWA install prompt so we can trigger it later.
// Must be set up early — Chrome fires this once after installability is confirmed.
let deferredInstallPrompt: Event | null = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  // Expose for debugging
  (window as unknown as Record<string, unknown>).__pwaInstallPrompt = e;
  console.log("[PWA] Install prompt available");
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  console.log("[PWA] App installed successfully");
});
