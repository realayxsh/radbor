(() => {
  const section = document.querySelector(".hero-section");
  const art = document.querySelector(".hero-art");
  if (!section || !art) return;

  const mascot = art.querySelector(".hero-mascot");
  const platforms = Array.from(art.querySelectorAll(".hero-platform"));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0;
  let previousProgress = -1;

  const clamp = (value) => Math.min(1, Math.max(0, value));

  const render = (progress) => {
    if (Math.abs(progress - previousProgress) < 0.001) return;
    previousProgress = progress;

    mascot.style.setProperty("--hero-base-opacity", String(1 - progress));
    mascot.style.setProperty("--hero-head-lift", `${Math.round(-mascot.offsetHeight * 0.04 * progress)}px`);
    mascot.style.setProperty("--hero-body-drop", `${Math.round(mascot.offsetHeight * 0.01 * progress)}px`);
    mascot.style.setProperty("--hero-seam-opacity", String(progress));

    platforms.forEach((platform, index) => {
      const revealStart = index * 0.075;
      const reveal = clamp((progress - revealStart) / (1 - revealStart));
      const x = Number(platform.dataset.x) * art.clientWidth * reveal;
      const y = Number(platform.dataset.y) * art.clientHeight * reveal;

      platform.style.setProperty("--platform-x", `${Math.round(x)}px`);
      platform.style.setProperty("--platform-y", `${Math.round(y)}px`);
      platform.style.setProperty("--platform-scale", String(0.72 + reveal * 0.28));
      platform.style.setProperty("--platform-opacity", String(reveal));
    });
  };

  const update = () => {
    frame = 0;
    if (reducedMotion.matches) {
      render(1);
      return;
    }

    const sectionTop = section.getBoundingClientRect().top + window.scrollY;
    const scrollRange = Math.max(1, section.offsetHeight - window.innerHeight);
    render(clamp((window.scrollY - sectionTop) / scrollRange));
  };

  const requestUpdate = () => {
    if (!frame) frame = window.requestAnimationFrame(update);
  };

  const handleResize = () => {
    previousProgress = -1;
    requestUpdate();
  };

  update();
  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", handleResize);
  reducedMotion.addEventListener("change", requestUpdate);
})();
