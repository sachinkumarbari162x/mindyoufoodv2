/* ============================================================
   SAMPLE DATA — until the endpoints land
   ------------------------------------------------------------
   Realistic rather than tidy, on purpose: a focus area typed in
   somebody's own words, a message that failed, people in three
   countries, a name long enough to wrap. A layout only ever
   tested against neat data is a layout that breaks in its first
   real week.

   Shown ONLY when /api/crm/overview is unreachable, and the
   footer says so loudly when it is.
   ============================================================ */

const hrs = (n) => new Date(Date.now() + n * 3600e3).toISOString();

export const SAMPLE = {
  stats: [
    { label: "Sessions", value: 12, change: 3, note: "vs last week" },
    { label: "Waiting", value: 3, change: 1, note: "vs last week" },
    { label: "Answered in", value: 4, unit: "h", change: -2, suffix: "h", note: "vs last week" },
    { label: "Booked out", value: 68, unit: "%", change: 0, suffix: "%", note: "of open slots" },
  ],

  waiting: [
    { id: "1", name: "Aisha Rahman", mode: "video", focusArea: "PCOS & hormonal health", startAt: hrs(52), holdExpiresAt: hrs(40) },
    { id: "2", name: "Meera Krishnan", mode: "audio", focusArea: "my sugar has been high since March", startAt: hrs(76), holdExpiresAt: hrs(64) },
    { id: "3", name: "Fatima Al-Balushi", mode: "in_person", focusArea: "Gut health", startAt: hrs(99), holdExpiresAt: hrs(87) },
  ],

  today: [
    { id: "4", name: "Priya Nair", mode: "video", focusArea: "Weight management", startAt: hrs(2), phone: "+919876543210", email: "priya@example.com", country: "India" },
    { id: "5", name: "Sana Qureshi", mode: "audio", focusArea: "Sports nutrition", startAt: hrs(5), phone: "+971501234567", email: "sana@example.com", country: "United Arab Emirates" },
  ],

  upcoming: [
    { id: "6", name: "Ritu Desai", mode: "in_person", focusArea: "Diabetes care", startAt: hrs(30), phone: "+919812345678", email: "ritu@example.com", country: "India" },
    { id: "7", name: "Hana Yusuf", mode: "video", focusArea: "Sustainable transformation", startAt: hrs(54), phone: "+447700900123", email: "hana@example.com", country: "United Kingdom" },
  ],

  people: [
    { id: "8", name: "Priya Nair", email: "priya@example.com", phone: "+919876543210", sessions: 4, lastSeenAt: hrs(-360) },
    { id: "9", name: "Ritu Desai", email: "ritu@example.com", phone: "+919812345678", sessions: 2, lastSeenAt: hrs(-720) },
    { id: "10", name: "Hana Yusuf", email: "hana@example.com", phone: "+447700900123", sessions: 1, lastSeenAt: hrs(-1440) },
  ],

  messages: [
    { id: "11", kind: "confirmed", status: "sent", recipient: "priya@example.com", templateId: "confirmed-video", templateVersion: "1", at: hrs(-6) },
    { id: "12", kind: "prep", status: "sent", recipient: "sana@example.com", templateId: "prep-audio", templateVersion: "1", at: hrs(-20) },
    { id: "13", kind: "held", status: "failed", recipient: "meera@example.com", templateId: "held", templateVersion: "1", at: hrs(-2) },
  ],

  exceptions: [
    { id: "14", onDate: hrs(96), kind: "closed", reason: "Away — family wedding" },
    { id: "15", onDate: hrs(168), kind: "open", startsMin: 600, endsMin: 780, reason: "Catch-up Saturday" },
  ],

  rules: [
    { weekday: 1, startsMin: 660, endsMin: 780 }, { weekday: 1, startsMin: 900, endsMin: 1080 },
    { weekday: 2, startsMin: 660, endsMin: 780 },
    { weekday: 3, startsMin: 660, endsMin: 780 }, { weekday: 3, startsMin: 900, endsMin: 1080 },
    { weekday: 4, startsMin: 660, endsMin: 780 },
    { weekday: 5, startsMin: 660, endsMin: 780 },
    { weekday: 6, startsMin: 600, endsMin: 720 },
  ],

  settings: { consultMinutes: 60, bufferMinutes: 0, maxPerDay: 3, minLeadHours: 12, autoAccept: false },
};
