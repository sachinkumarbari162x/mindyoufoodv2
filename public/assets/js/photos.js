/* ============================================================
   PHOTOGRAPHS — taking one, shrinking it, getting it there
   ------------------------------------------------------------
   THE PHONE DOES THE COMPRESSION, and it is not an optimisation.
   A modern camera produces four to eight megabytes. Sending that
   over a kitchen's worth of signal is a minute of waiting and a
   chunk of somebody's data allowance, three times a day, and the
   photograph is going to be looked at once on a laptop screen. So
   it is drawn onto a canvas at 1280px on the long edge and
   re-encoded as JPEG at 0.72 — typically 120 to 250 KB, which is
   twenty to fifty times smaller and indistinguishable at the size
   anybody views it.

   THE QUEUE IS INDEXEDDB, NOT localStorage. The tick queue is a
   few hundred bytes and lives happily in localStorage; a
   photograph is a quarter of a megabyte and localStorage is a 5 MB
   cliff that throws when you reach it. IndexedDB stores the Blob
   itself, survives the app being closed, and has room.

   NOTHING IS EVER LOST TO SIGNAL. A photo taken in a basement
   sits in the queue until there is a network, exactly like a tick.
   ============================================================ */

const DB_NAME = "myf-programme";
const STORE = "outbox-photos";

/* 1280 on the long edge. Big enough that she can see whether that is
   a bowl of dal or a bowl of rice, small enough to send on a train. */
const MAX_EDGE = 1280;
const QUALITY = 0.72;

/* ---- the queue ---------------------------------------------------- */

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, run) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const out = run(store);
    t.oncomplete = () => resolve(out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}

const queuePhoto = (entry) => tx("readwrite", (s) => s.add(entry));
const allPhotos = () => tx("readonly", (s) => s.getAll());
const dropPhoto = (id) => tx("readwrite", (s) => s.delete(id));

/** How many are still waiting. */
export async function pending() {
  try {
    return (await allPhotos()).length;
  } catch {
    return 0;
  }
}

/* ---- shrinking ----------------------------------------------------- */

/**
 * A File from a camera in, a small JPEG Blob out.
 *
 * createImageBitmap rather than an <img> and an object URL: it
 * decodes off the main thread, so a big photograph does not freeze
 * the app while it is being read.
 */
export async function shrink(file) {
  if (!file || !file.type.startsWith("image/")) {
    return { ok: false, why: "that is not a photo" };
  }

  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return { ok: false, why: "that photo could not be read" };
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();

  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", QUALITY));
  if (!blob) return { ok: false, why: "that photo could not be read" };

  /* JPEG ONLY, ALWAYS RE-ENCODED. Drawing to a canvas and re-encoding
     also strips the EXIF the camera attached — which on most phones
     includes the GPS coordinates of the kitchen it was taken in.
     Nobody asked for that and nobody should be storing it. */
  return { ok: true, blob, width: w, height: h, bytes: blob.size };
}

/* ---- sending -------------------------------------------------------- */

async function post(api, entry) {
  const url = api(`/photo?checkin=${encodeURIComponent(entry.checkinId)}` +
    (entry.takenAt ? `&taken=${encodeURIComponent(entry.takenAt)}` : ""));

  return fetch(url, {
    method: "POST",
    /* The bytes, bare. No form, no boundary, nothing to parse on the
       other side — see readBytes in the BFF. */
    headers: { "Content-Type": entry.blob.type || "image/jpeg" },
    body: entry.blob,
  });
}

/**
 * Take one, shrink it, and either send it or queue it.
 * Resolves as soon as the photo is SAFE, not when it has arrived —
 * queued counts as safe, which is the whole point.
 */
export async function send(api, file, checkinId) {
  const small = await shrink(file);
  if (!small.ok) return small;

  const entry = {
    checkinId,
    blob: small.blob,
    takenAt: new Date(file.lastModified || Date.now()).toISOString(),
    at: Date.now(),
  };

  if (navigator.onLine) {
    try {
      const res = await post(api, entry);
      if (res.ok) return { ok: true, sent: true, bytes: small.bytes };
      /* A refusal is final. Queueing it would retry forever against a
         server that has already said no. */
      if (res.status >= 400 && res.status < 500) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, why: body.message || "that photo was refused" };
      }
    } catch {
      /* fall through and queue it */
    }
  }

  await queuePhoto(entry);
  return { ok: true, sent: false, bytes: small.bytes };
}

/** Send whatever is waiting. Called on load and whenever the network
    comes back, exactly like the tick queue's drain. */
export async function drain(api) {
  if (!navigator.onLine) return;
  let waiting;
  try {
    waiting = await allPhotos();
  } catch {
    return;
  }

  for (const entry of waiting) {
    try {
      const res = await post(api, entry);
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        // Sent, or refused for good. Either way it stops waiting.
        await dropPhoto(entry.id);
        continue;
      }
      return; // 5xx — the server is unwell; keep the rest for later
    } catch {
      return; // still no network
    }
  }
}
