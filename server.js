/* ============================================================
   MIND YOUR FOOD · v2.0.0 — local dev server
   Zero dependencies (node: built-ins only). Run with:

       node server.js            → http://localhost:5501
       PORT=4000 node server.js

   Serves ./public statically. Supports HTTP Range requests so
   the hero video can seek/stream instead of being downloaded
   whole, and sends no-cache headers so an edit shows up on a
   plain refresh (the stale-JS trap v1 hit with serve.cjs).

   /api/* is proxied to the receptionist BFF (services/node-bff)
   so the browser only ever talks to one origin — which means no
   CORS in development and none in production either, where Caddy
   does the same job in front of both.
   ============================================================ */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const url = require("node:url");

const PORT = Number(process.env.PORT) || 5501;
const ROOT = path.join(__dirname, "public");
// The CRM is deliberately not inside public/ — see resolveFile.
const CRM_ROOT = path.join(__dirname, "crm");

/* The prototype. A third root, served only when TRIAL_ENABLED=1 and
   only to loopback — the pages behind it have no login at all, and
   they render real client names. Off by default, because a
   prototype that is off unless asked for cannot be left running by
   accident. */
const TRIAL_ROOT = path.join(__dirname, "trial");
const TRIAL_ON = process.env.TRIAL_ENABLED === "1";

/* The session cookie, verified here as well as in the BFF.

   Required by neither security nor duplication: the API is the real
   boundary — every figure in the CRM arrives through /api/crm/*,
   which 401s without a session — and these files are an empty shell
   without it. This exists so she meets a login page instead of a
   dashboard full of dashes wondering what broke.

   The same module the BFF uses, required across the boundary rather
   than reimplemented. Two implementations of one signature check is
   one more than can be kept in agreement. */
const authCrypto = require("./services/node-bff/auth/crypto");
const SESSION_SECRET = process.env.SESSION_SECRET || "";

/* ============================================================
   THE CRM GATE
   ------------------------------------------------------------
   Two doors. /crm is her workspace; the raw-table pages are a
   separate account with a separate session, because whoever can
   read every row of every table should have proved it separately.

   WHAT THIS IS AND IS NOT. The security boundary is the API: every
   /api/crm/* route 401s without a session, and these HTML files are
   an empty shell without it. This gate exists so she meets a login
   page instead of a dashboard full of dashes.

   It reads the cookie with the SAME function the BFF uses. The
   previous version had its own, built from a regex in a template
   literal, and the two disagreed — which produced a redirect loop
   rather than an honest refusal. One reader, one answer.

   `why` is returned alongside the verdict and logged on refusal.
   Every request in that loop looked individually fine; being able
   to read the reason is what ends an hour of guessing.
   ============================================================ */
const VIEWER_PAGES = new Set(["/database.html", "/crm-tables.html"]);

/* WHAT A STRANGER MAY DOWNLOAD, and nothing beyond it.
 *
 * This was `p.startsWith("/assets/")`, which opened the whole tree —
 * so anybody at all could fetch all 34 CRM modules without a session
 * and read, in the comments, which routes exist, where the guards
 * are, and which bugs used to be there. None of that breaks a guard
 * on its own; all of it is a map, handed out, to a workspace that is
 * meant to be private.
 *
 * The list is exactly what login.html needs to draw itself and take
 * a password — its three stylesheets and one script, which imports
 * nothing. Everything else now answers to the same gate the pages
 * do.
 *
 * WHY A LIST RATHER THAN A PATTERN. A pattern is a promise about
 * files that do not exist yet: "/assets/js/pages/" would have opened
 * today.js the moment somebody moved it. Adding a file to the login
 * screen should require saying so here, out loud.
 */
const OPEN_ASSETS = new Set([
  "/assets/crm.css",
  "/assets/js/pages/login.js",
]);

/* Stylesheets and fonts stay open, and that is a line drawn where the
   risk actually is. crm.css @imports the whole css/ tree, so the
   browser fetches every one of them before anybody has signed in —
   and a login page stripped of its stylesheet reads as a broken site
   rather than a locked one. They are also the wrong thing to hide:
   a stylesheet describes spacing. It names no route, explains no
   guard, and reveals nothing a screenshot would not.

   THE JAVASCRIPT IS THE PART THAT TALKS. That is where the routes,
   the payload shapes and 869 lines of comments about how this system
   defends itself live, so /assets/js/ is closed with exactly one
   exception — the script that draws the login screen, which imports
   nothing and therefore drags nothing open behind it. */
const OPEN_ASSET_DIRS = ["/assets/css/", "/assets/fonts/"];

const ALWAYS_OPEN = (p) =>
  p === "/login.html" ||
  OPEN_ASSETS.has(p) ||
  OPEN_ASSET_DIRS.some((dir) => p.startsWith(dir));

function crmGate(req, page) {
  if (ALWAYS_OPEN(page)) return { ok: true, why: "open" };

  /* No secret means this check cannot be made honestly, so it stands
     aside rather than pretending. Nothing is exposed: the API still
     refuses. run.js sets one, so this is close to unreachable. */
  if (!SESSION_SECRET) return { ok: true, why: "no-secret" };

  const wantViewer = VIEWER_PAGES.has(page);
  const role = wantViewer ? "viewer" : "crm";
  const token = authCrypto.readCookie(req.headers.cookie, wantViewer ? "myf_view" : "myf_crm");

  if (!token) return { ok: false, why: "no-cookie", role };

  const payload = authCrypto.unsign(token, SESSION_SECRET);
  if (!payload) return { ok: false, why: "bad-signature", role };
  if (payload.mfa !== true) return { ok: false, why: "no-second-factor", role };
  if ((payload.role || "crm") !== role) return { ok: false, why: "other-door", role };

  return { ok: true, why: "signed-in", role };
}

const BFF_PORT = Number(process.env.BFF_PORT) || 5502;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  /* Its own type, not application/json. Chrome will install a PWA
     from a manifest served as octet-stream and Safari will not, and
     "it works on my phone" is the worst way to find that out. */
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const NO_CACHE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};

/** Resolve a request path to a real file, or null.
 *
 *  Two roots. `public/` is the site; `crm/` is the practitioner's
 *  workspace and lives OUTSIDE public on purpose, so it can never be
 *  reached by an unlucky path — only through the explicit prefix
 *  below. In production Caddy puts basic auth in front of /crm; this
 *  server is local-only and does not pretend otherwise.
 */
async function resolveFile(pathname, req) {
  // decodeURIComponent can throw on a malformed escape — treat that as a miss.
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  let root = ROOT;
  let crm = false;
  if (decoded === "/crm" || decoded.startsWith("/crm/")) {
    root = CRM_ROOT;
    decoded = decoded.slice(4) || "/";
    crm = true;
  } else if (decoded === "/trial" || decoded.startsWith("/trial/")) {
    if (!TRIAL_ON) return null;
    const ip = req.socket.remoteAddress || "";
    const loopback =
      ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (!loopback) return null;
    root = TRIAL_ROOT;
    decoded = decoded.slice(6) || "/";
  }

  const target = path.join(root, path.normalize(decoded));

  // Directory traversal guard: the resolved path must stay under its
  // own root. Checked after the prefix is stripped, so `/crm/../..`
  // cannot climb out through the alias.
  if (target !== root && !target.startsWith(root + path.sep)) return null;

  try {
    const stat = await fsp.stat(target);

    /* A DIRECTORY ASKED FOR WITHOUT A TRAILING SLASH REDIRECTS TO ONE,
       and this has to happen BEFORE the CRM gate below. The gate hands
       back login.html in place of the page asked for -- deliberately,
       so the visited path stays out of history -- and that page has
       relative asset paths of its own. Served at /crm, its
       ./assets/crm.css resolves against / and 404s; at /crm/ it
       resolves against /crm/ and loads. So the first sign-in on the
       box produced a completely unstyled login page and a wall of
       404s naming the assets, which is not where the fault was.

       Deciding this on the stat alone, before any auth, is also the
       only place it can go: it is a fact about the URL, not about who
       is asking. The query is carried across so a redirect cannot
       silently drop one. */
    if (stat.isDirectory() && !pathname.endsWith("/")) {
      const url = req?.url || "";
      const q = url.includes("?") ? url.slice(url.indexOf("?")) : "";
      return { redirect: pathname + "/" + q };
    }

    if (crm) {
      // Signed out: hand back the login page instead of the page asked
      // for. A redirect would work too and would put the visited path
      // in history, which is a small leak of where she was going.
      const page = decoded === "/" ? "/index.html" : decoded;
      const gate = crmGate(req, page);
      if (!gate.ok) {
        /* Said out loud. A refusal that leaves no trace is what made
           the redirect loop so hard to read. */
        console.log(`[site] ${page} refused: ${gate.why}`);

        /* A PAGE gets the login screen; anything else gets a refusal.
           Handing login.html back in answer to a request for a script
           would be a 200 with HTML in it — the browser rejects it on
           the content type anyway, and a "success" that is nothing of
           the sort is the kind of thing that costs an hour to read in
           a network log. */
        if (!/\.html?$/i.test(page)) return { refused: true };

        const login = path.join(CRM_ROOT, "login.html");
        const st = await fsp.stat(login);
        /* A redirect rather than serving the login page in place,
           because the two doors need different passwords and the
           page has to be told which one it is opening. The door is
           all that travels — not the path she was heading for. */
        if (VIEWER_PAGES.has(page)) {
          return { redirect: "/crm/login.html?door=viewer" };
        }
        return { file: login, size: st.size };
      }
    }
    if (stat.isDirectory()) {
      /* A DIRECTORY ASKED FOR WITHOUT A TRAILING SLASH MUST REDIRECT
         TO ONE. Serving its index.html in place looks identical in a
         terminal -- both are 200 with the same bytes -- and is broken
         in a browser, because relative URLs resolve against the
         directory of the current path. At /crm the base is /, so the
         page's own `./assets/crm.css` is fetched as /assets/crm.css
         and 404s; at /crm/ it is fetched as /crm/assets/crm.css and
         works. Every stylesheet and every script in the CRM failed
         this way on the first real sign-in, and the page came up
         unstyled with a wall of 404s that pointed at the assets
         rather than at the missing slash.

         The query is carried across so a redirect never silently
         drops one. */
      const index = path.join(target, "index.html");
      const indexStat = await fsp.stat(index);
      return { file: index, size: indexStat.size };
    }
    return { file: target, size: stat.size };
  } catch {
    return null;
  }
}

/** Pipe an /api/* request through to the BFF, streaming both ways. */
function proxy(req, res) {
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: BFF_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${BFF_PORT}` },
    },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    }
  );

  upstream.on("error", (err) => {
    // The BFF being down must read as "the desk is unavailable", not
    // as a broken page — the widget has a fallback for exactly this.
    if (res.headersSent) return res.end();
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", ...NO_CACHE });
    res.end(
      JSON.stringify({
        error: "desk_unavailable",
        message: `The front desk service is not running (${err.code}). Start it with \`node run.js\`.`,
      })
    );
  });

  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) return proxy(req, res);

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end("Method Not Allowed");
    return;
  }

  const { pathname } = url.parse(req.url);

  /* /c/<token> — the page behind a WhatsApp link.
   *
   * Every one of these URLs serves the SAME file. The token is not a
   * filename and is never used to look one up; the page reads it from
   * the address itself and asks the API what it means. That is what
   * keeps a path segment somebody else controls away from the
   * filesystem entirely — there is no traversal to guard against when
   * the untrusted part of the path is never touched.
   *
   * A path rather than ?t= because Meta's dynamic URL button appends
   * to a fixed base, and because query strings are what proxies and
   * access logs record most eagerly. */
  const consultLink = /^\/c(\/|$)/.test(pathname);

  /* /p/<token> — the care plan behind an emailed link.
   *
   * Exactly the same trick as /c/ above and for exactly the same
   * reason: every one of these URLs serves ONE file, the token is
   * never used to look a filename up, and the page reads it out of
   * the address and asks the API what it means. There is no
   * traversal to defend against when the untrusted segment never
   * touches the filesystem. */
  const planLink = /^\/p(\/|$)/.test(pathname);

  /* /me/<token> — NOW THE ACCOUNT PANEL, not the old programme app.

     There were two client apps and they had grown to overlap
     almost entirely: both showed the plan, both took a tick, and
     they looked nothing like each other. Two installable apps on
     one home screen is a client wondering which of them is real.

     So there is one, and it is the account panel. The token still
     works and still gets somebody to their food without typing
     anything — see client/routes.js for what it opens and, more
     to the point, what it does NOT: a token in a URL is forwarded
     in WhatsApp and screenshotted, so it opens the programme
     screens and never the receipts, the lab results or the
     documents. Those want the six-digit code.

     programme.html, its manifest and its service worker are left
     on disk and unrouted. Nothing serves them; a release from now
     they can go. The old worker un-registers itself on the way
     out — see the note in programme-sw.js. */
  const programme = /^\/me(\/|$)/.test(pathname);

  const hit = await resolveFile(
    consultLink ? "/consultation.html"
      : planLink ? "/plan.html"
      : programme ? "/account.html"
      : pathname === "/" ? "/index.html"
      : pathname,
    req
  );

  if (hit?.redirect) {
    res.writeHead(302, { Location: hit.redirect, ...NO_CACHE }).end();
    return;
  }

  /* Signed out, and asking for something that is not a page. Said as
     401 rather than 404: the file exists, and pretending otherwise
     would be a lie the browser then has to be debugged through. */
  if (hit?.refused) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", ...NO_CACHE });
    res.end("Sign in to load this.\n");
    return;
  }

  if (!hit) {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE });
    res.end("<h1>404</h1><p>Not found.</p>");
    return;
  }

  const type = MIME[path.extname(hit.file).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;

  // ---- ranged (video seeking) ----
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const hasStart = match[1] !== "";
      const hasEnd = match[2] !== "";
      // "bytes=-500" means the LAST 500 bytes, not "from 0 to 500".
      let start = hasStart ? Number(match[1]) : hit.size - Number(match[2]);
      let end = hasStart ? (hasEnd ? Number(match[2]) : hit.size - 1) : hit.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, hit.size - 1);

      if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${hit.size}` }).end();
        return;
      }

      res.writeHead(206, {
        "Content-Type": type,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${hit.size}`,
        "Accept-Ranges": "bytes",
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(hit.file, { start, end }).pipe(res);
      return;
    }
  }

  // ---- whole file ----
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": hit.size,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    ...NO_CACHE,
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(hit.file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Mind Your Food v2 → http://localhost:${PORT}`);
  console.log(`serving ${ROOT}`);
});
