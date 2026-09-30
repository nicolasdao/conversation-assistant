// hey-tattle.com/docs: lights the contents entry of the section on screen, like the landing page's rundown tabs, and on a
// phone folds the contents away (open after a tap on "On this page", closed again once a section is picked).
(function () {
  const toc = document.getElementById("toc");
  if (!toc) return;
  const links = [...toc.querySelectorAll('a[href^="#"]')];
  const sections = links.map((a) => document.getElementById(a.getAttribute("href").slice(1)));
  const phone = matchMedia("(max-width: 899px)");

  function fold() { toc.open = !phone.matches; }
  fold();
  phone.addEventListener("change", fold);
  toc.addEventListener("click", (e) => { if (phone.matches && e.target.closest("a")) toc.open = false; });

  // A section is "on air" while it crosses a line a quarter of the way down the screen.
  let current = -1;
  function pick() {
    const line = window.innerHeight / 4;
    let at = 0;
    sections.forEach((sec, i) => { if (sec && sec.getBoundingClientRect().top <= line) at = i; });
    if (at === current) return;
    current = at;
    links.forEach((a, i) => { if (i === at) a.setAttribute("aria-current", "location"); else a.removeAttribute("aria-current"); });
    const a = links[at];
    if (a && !phone.matches && toc.scrollHeight > toc.clientHeight) {
      const top = a.offsetTop - toc.clientHeight / 2;
      toc.scrollTo({ top, behavior: "smooth" });
    }
  }
  let queued = false;
  window.addEventListener("scroll", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; pick(); });
  }, { passive: true });
  window.addEventListener("resize", pick);
  pick();
})();
