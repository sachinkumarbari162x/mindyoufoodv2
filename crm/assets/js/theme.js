/* ============================================================
   THEME — system, light, dark
   ------------------------------------------------------------
   Three states, not two. "System" is the ABSENCE of the
   data-theme attribute, which is what lets the media query in
   tokens.css decide. Stamping data-theme="system" would match
   neither selector and leave the page unstyled.

   The pre-paint script in index.html applies the stored choice
   before first paint; this only handles changing it.
   ============================================================ */

const KEY = "myf-theme";
const ORDER = ["system", "light", "dark"];

export function current() {
  try {
    const t = localStorage.getItem(KEY);
    return ORDER.includes(t) ? t : "system";
  } catch {
    return "system";
  }
}

export function apply(theme) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);

  const label = document.querySelector("[data-theme-label]");
  if (label) label.textContent = theme[0].toUpperCase() + theme.slice(1);

  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    /* private mode — the choice simply does not persist */
  }
}

export function mount() {
  const btn = document.querySelector("[data-theme-toggle]");
  if (btn) {
    btn.addEventListener("click", () => {
      apply(ORDER[(ORDER.indexOf(current()) + 1) % ORDER.length]);
    });
  }
  apply(current());
}
