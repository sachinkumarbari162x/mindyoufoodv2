/* ============================================================
   SECTION TRACKER — which panel is being read
   ------------------------------------------------------------
   Marks the nav link whose target is currently in view. Written
   with selectors passed in, so the same spy serves Overview's
   sub-nav today and anything else with anchored panels later.
   ============================================================ */

/**
 * @param {string} linkSelector    anchors carrying href="#id"
 * @param {string} targetSelector  the elements they point at
 */
export function mount(linkSelector, targetSelector) {
  const links = new Map(
    [...document.querySelectorAll(linkSelector)]
      .filter((a) => a.getAttribute("href")?.startsWith("#"))
      .map((a) => [a.getAttribute("href").slice(1), a])
  );
  if (!links.size || !("IntersectionObserver" in window)) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const link = links.get(entry.target.id);
        if (link) link.setAttribute("aria-current", String(entry.isIntersecting));
      }
    },
    // A band across the upper-middle of the viewport: whichever
    // panel occupies it is the one being read. Without the negative
    // bottom margin three panels match at once on a tall screen and
    // the marker flickers between them.
    { rootMargin: "-18% 0px -68% 0px" }
  );

  document.querySelectorAll(targetSelector).forEach((el) => observer.observe(el));
}
