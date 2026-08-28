import "htmx.org";
import { initializeCampaignEditor } from "./campaign-editor";

function markCurrentNavigation() {
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  document.querySelectorAll<HTMLAnchorElement>("nav a.nav-link").forEach((link) => {
    const linkPath = new URL(link.href).pathname.replace(/\/$/, "") || "/";
    const current = linkPath === "/admin" ? path === "/admin" : path === linkPath || path.startsWith(`${linkPath}/`);
    if (current) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

markCurrentNavigation();
initializeCampaignEditor();

document.addEventListener("htmx:responseError", () => {
  document.documentElement.dataset.requestError = "true";
  window.setTimeout(() => delete document.documentElement.dataset.requestError, 2500);
});

document.addEventListener("htmx:afterSwap", () => {
  markCurrentNavigation();
  initializeCampaignEditor();
  document.querySelector<HTMLElement>("[autofocus]")?.focus();
});
