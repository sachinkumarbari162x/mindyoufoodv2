-- ============================================================
--  WHAT THE ACCOUNT PANEL ANSWERS
-- ------------------------------------------------------------
--  crm.knowledge holds two different bodies of answers, told
--  apart by `audience`:
--
--    desk    a stranger asking about booking, price and hours.
--    client  somebody already on a plan, asking about the plan.
--
--  They must never answer each other's questions. A visitor
--  asking "how much is it" should not be told to log a swap in
--  the note on that meal; a client asking about swaps should not
--  be quoted a consultation fee. One editor in the CRM, one
--  table, one column keeping them apart — and a unique index on
--  (audience, intent) so the same intent can exist once in each
--  without colliding.
--
--  THIS IS CONFIGURATION, NOT CLIENT DATA. It is not in
--  seed_clients.sql because it belongs to the practice rather
--  than to a person: all three clients see these six answers,
--  and so will the fourth.
--
--  Written in her voice, because they are her answers — the
--  things she says often enough to be worth writing down once.
--  She edits them in the CRM afterwards; this is only the
--  starting set so the screen is not empty on day one.
--
--    psql -d "$DATABASE_URL" -f db/config_client_questions.sql
-- ============================================================

\set ON_ERROR_STOP on

BEGIN;

/* Re-runnable: the unique index is on (audience, intent) WHERE
   active, so an upsert keyed on the intent replaces the answer
   rather than adding a second copy of the question. */
INSERT INTO crm.knowledge (intent, label, answer, audience, active) VALUES

('client_swaps',
 'Can I swap something out?',
$$Yes, within reason. Rice swaps one-for-one with roti by weight, sweet potato with potato or a banana, dal with rajma, chana or chicken.

Keep the swap in the same meal, and tell me what you did at your review — that is more useful to me than a perfect week you had to force.$$,
 'client', true),

('client_missed_meal',
 'I missed a meal. Do I make it up later?',
$$No. Leave it and carry on with the next one as written.

Doubling up moves the problem rather than solving it, and a single missed meal changes nothing. A pattern of missed meals does — so if it is happening most days, that is worth a conversation rather than more effort.$$,
 'client', true),

('client_drinks',
 'What about tea, coffee and alcohol?',
$$Two cups of tea or coffee a day is fine, without sugar, and none after 10 PM — caffeine that late costs you the sleep window, and the sleep window is part of the plan.

Alcohol is not forbidden and it is not free. Tell me what you actually drink and I will build around it. I would rather have a plan that fits your life than one you abandon in a fortnight.$$,
 'client', true),

('client_progress',
 'When will I see a change?',
$$Slower than you would like, and unevenly.

Judge it over four weeks, never on one morning. A single reading is mostly water, salt, and what time you weighed — which is why your weight is drawn as a line here and not as a number to beat.$$,
 'client', true),

('client_weighing',
 'Do I have to weigh everything forever?',
$$For the first two weeks, yes.

After that most people can see 150 g of rice on a plate without a scale, and that is exactly what the first two weeks were for. Go back to weighing for a few days any time portions start drifting.$$,
 'client', true),

('client_worried',
 'Something does not feel right. Who do I tell?',
$$Me, directly, and quickly.

Anything clinical — dizziness, a reaction, a medicine that does not agree with you — is not a message to leave until your next appointment. Ask for a session here, or reply to any email of mine.

If it is urgent, see a doctor first and tell me afterwards. I am your dietitian, not your emergency service.$$,
 'client', true)

ON CONFLICT (audience, intent) WHERE active DO UPDATE
  SET label = EXCLUDED.label,
      answer = EXCLUDED.answer,
      updated_at = now();

COMMIT;

\echo 'client questions: 6 answers loaded for the account panel'
