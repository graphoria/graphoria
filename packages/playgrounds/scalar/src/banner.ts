import { subscribe } from "./auth";

subscribe((message) => {
  const el = document.createElement("div");
  el.className = "token-banner";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
});
