/* ============================================================
   OUTBOX — the provider that does not send
   ------------------------------------------------------------
   Writes each message to disk as a .eml file instead of posting
   it. Double-click one and it opens in a mail client looking
   exactly as it would arrive.

   THIS IS THE DEFAULT, AND THAT IS THE POINT. With no API key
   configured — a fresh clone, a colleague's laptop, a test run,
   a staging box somebody forgot to configure — this system
   CANNOT email a real client by accident. Making the safe state
   the default one is worth more than any warning in a README,
   because the README is not read at the moment it matters.

   It is also how the templates get worked on. Changing a
   sentence and looking at the result should not cost a real send
   to somebody's inbox, and it should not need an account.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DIR = process.env.MAIL_OUTBOX_DIR || path.join(__dirname, "..", "outbox");

/** A filename that sorts by time and says what it is at a glance. */
function filename(m) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const who = String(m.to || "unknown").replace(/[^\w.@-]/g, "_");
  return `${stamp}__${m.templateId || "message"}__${who}.eml`;
}

async function send(m) {
  try {
    fs.mkdirSync(DIR, { recursive: true });

    /* A real multipart/alternative envelope rather than a dump of
       the fields. It costs a few lines and it means the file opens
       as an email — headers, both bodies, the lot — so what is
       reviewed here is what will actually be received. */
    const boundary = "myf-" + Math.random().toString(36).slice(2, 12);
    const eml = [
      `From: ${m.fromName ? `${m.fromName} <${m.from}>` : m.from}`,
      `To: ${m.to}`,
      ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
      `Subject: ${m.subject}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `X-Mind-Your-Food-Template: ${m.templateId}@${m.templateVersion}`,
      `X-Mind-Your-Food-Note: NOT SENT — written by the outbox provider`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      m.text || "",
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      m.html || "",
      ``,
      `--${boundary}--`,
      ``,
    ].join("\r\n");

    const file = path.join(DIR, filename(m));
    fs.writeFileSync(file, eml, "utf8");

    console.log(`[mail] outbox → ${file}`);
    /* Reported as a success, because the send DID do what this
       provider promises. Reporting failure would fill the Messages
       page with red rows on every developer machine and teach
       everybody to ignore it. The header above, the log line, and
       the provider name recorded on the row all say it did not
       leave the building. */
    return { ok: true, id: path.basename(file) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { name: "outbox", send };
