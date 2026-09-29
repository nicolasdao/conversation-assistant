// The pinned header bar: lights the tab of the section on screen (like a segment going on air in the app's rundown),
// moves the playhead along the bar's bottom edge, and shows the bar's compact Download once the hero's is off screen.
(function () {
  const bar = document.getElementById("bar");
  const tabs = document.getElementById("tabs");
  const fill = document.getElementById("bar-fill");
  const track = document.getElementById("bar-track");
  if (!bar || !tabs) return;
  const links = [...tabs.querySelectorAll("a")];
  const sections = links.map((a) => document.querySelector(a.getAttribute("href")));

  // ---------- the tab of the section on screen ----------
  let current = null;
  function setCurrent(i) {
    if (i === current) return;
    current = i;
    links.forEach((a, n) => {
      if (n === i) a.setAttribute("aria-current", "location");
      else a.removeAttribute("aria-current");
    });
    // On a phone the tabs scroll sideways: bring the active one into view without moving the page.
    const a = links[i];
    if (a && tabs.scrollWidth > tabs.clientWidth) {
      tabs.scrollTo({ left: a.offsetLeft - (tabs.clientWidth - a.offsetWidth) / 2, behavior: "smooth" });
    }
  }
  // A section is "on air" while it crosses a line a third of the way down the screen.
  function pick() {
    const line = window.innerHeight / 3;
    let at = null;
    sections.forEach((sec, i) => { if (sec && sec.getBoundingClientRect().top <= line) at = i; });
    // Past the end of the last section (the sign-off and footer), keep the last tab lit.
    setCurrent(at);
  }

  // ---------- the playhead and the section ticks ----------
  function placeTicks() {
    track.querySelectorAll("b").forEach((b) => b.remove());
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max <= 0) return;
    const barH = bar.offsetHeight;
    sections.forEach((sec) => {
      if (!sec) return;
      const y = Math.min(1, Math.max(0, (sec.getBoundingClientRect().top + window.scrollY - barH) / max));
      const b = document.createElement("b");
      b.style.left = `${(y * 100).toFixed(2)}%`;
      track.append(b);
    });
  }
  function progress() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    fill.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`;
  }

  let queued = false;
  function onScroll() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; progress(); pick(); bar.classList.toggle("scrolled", window.scrollY > 8); });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", () => { placeTicks(); onScroll(); });
  // Sections grow as their demos fill in and fonts load: re-place the ticks when the page settles.
  window.addEventListener("load", () => { placeTicks(); onScroll(); });
  if ("ResizeObserver" in window) new ResizeObserver(() => placeTicks()).observe(document.body);
  placeTicks();
  onScroll();

  // ---------- the bar's Download, once the hero's big one is off screen ----------
  const bigDownload = document.querySelector(".hero .dl");
  const barDownload = bar.querySelector(".bar-dl");
  if (bigDownload && barDownload && "IntersectionObserver" in window) {
    new IntersectionObserver(([e]) => {
      const show = !e.isIntersecting && e.boundingClientRect.top < 0;
      bar.classList.toggle("show-dl", show);
      barDownload.tabIndex = show ? 0 : -1;
    }, { threshold: 0 }).observe(bigDownload);
  }
})();
