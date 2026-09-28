// Download for Mac, shared by every experiment.
//
// Markup:
//   <a data-download href="https://github.com/nicolasdao/conversation-assistant/releases/latest">Download for Mac</a>
//   <span data-version></span>  -> "v0.6.2"      <span data-size></span> -> "146 MB"
//   [data-when="mac"] / [data-when="other"]      -> shown only on a Mac / only elsewhere (theme.css)
//   <button data-copy-link>Copy link</button>     -> copies the page's URL, says "Copied"
//
// Every [data-download] link points at the latest release page at first, then at the DMG itself once
// GitHub's API names it. The DMG's file name carries the version, so it cannot be a fixed URL.
//
// Script API: window.CA = { repo, releasesUrl, isMac, reducedMotion, release (null until loaded), ready(cb) }
// A click on a download link also dispatches `ca:download` on window (detail: { url, el }) before navigating,
// for a celebration; never cancel it.
(function () {
  const repo = "nicolasdao/conversation-assistant";
  const releasesUrl = `https://github.com/${repo}/releases/latest`;
  const ua = navigator.userAgent;
  // Only a Mac says "Macintosh" (an iPhone says "like Mac OS X"). An iPad also says it, but has a touch screen.
  const isMac = /Macintosh/.test(ua) && !(navigator.maxTouchPoints > 1);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.documentElement.dataset.platform = isMac ? "mac" : "other";

  const waiting = [];
  const CA = {
    repo, releasesUrl, isMac, reducedMotion, release: null,
    ready(cb) { if (CA.release) cb(CA.release); else waiting.push(cb); },
  };
  window.CA = CA;

  function apply(release) {
    document.querySelectorAll("[data-download]").forEach((a) => { if (a.tagName === "A") a.href = release.url; });
    document.querySelectorAll("[data-version]").forEach((el) => { el.textContent = release.version; });
    document.querySelectorAll("[data-size]").forEach((el) => { el.textContent = release.size; });
  }

  function onReady() {
    document.querySelectorAll("[data-download]").forEach((a) => { if (a.tagName === "A" && !a.getAttribute("href")) a.href = releasesUrl; });
    document.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("[data-download]");
      if (a) window.dispatchEvent(new CustomEvent("ca:download", { detail: { url: a.href || releasesUrl, el: a } }));
      const copy = e.target.closest && e.target.closest("[data-copy-link]");
      if (copy) {
        const label = copy.textContent;
        navigator.clipboard.writeText(location.href).then(
          () => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = label; }, 1800); },
          () => { copy.textContent = location.href; },
        );
      }
    });
    load();
  }

  async function load() {
    let release = null;
    try { release = JSON.parse(sessionStorage.getItem("ca.release") || "null"); } catch { /* storage blocked */ }
    if (!release) {
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
        if (!res.ok) return;
        const data = await res.json();
        const dmg = (data.assets || []).find((a) => /-arm64\.dmg$/.test(a.name));
        if (!dmg) return;
        release = { version: data.tag_name, url: dmg.browser_download_url, size: `${Math.round(dmg.size / 1e6)} MB` };
        try { sessionStorage.setItem("ca.release", JSON.stringify(release)); } catch { /* storage blocked */ }
      } catch { return; } // offline or rate-limited: the links keep pointing at the release page
    }
    CA.release = release;
    apply(release);
    waiting.splice(0).forEach((cb) => cb(release));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", onReady);
  else onReady();
})();
