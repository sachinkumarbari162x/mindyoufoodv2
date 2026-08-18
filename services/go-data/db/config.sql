-- ============================================================
--  CONFIGURATION — what the system needs to work at all
-- ------------------------------------------------------------
--  Not the practice and not a fixture: the country list the form
--  offers, what the front desk knows how to answer, her weekly
--  hours. A database without these has a working schema and a
--  site that cannot take a booking.
--
--  Kept apart from schema.sql on purpose. That file describes
--  STRUCTURE and contains no rows at all, so it can be read as a
--  description of the system rather than a description of one
--  installation of it. This is the rows.
--
--  Deliberately NOT in here: crm.staff. That row holds a password
--  hash, and a credential in a repository is a credential. A new
--  database gets its first officer through the CRM's own setup
--  screen instead.
--
--  Generated 2026-08-16 15:04:15Z — 101 rows.
--
--    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f config.sql
--
--  LOAD THIS BEFORE dump.sql. Every person names a country, and
--  crm.people.country_iso2 is a foreign key into the list below —
--  so a practice loaded into a database without it is refused on
--  the very first row, which is the schema being right rather
--  than an inconvenience.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

-- crm.countries — 74 rows
COPY crm.countries ("iso2", "name", "dial_code", "phone_digits", "priority", "active") FROM stdin;
AE	United Arab Emirates	+971	{9}	\N	t
AF	Afghanistan	+93	{9}	\N	t
AR	Argentina	+54	{10}	\N	t
AT	Austria	+43	{}	\N	t
AU	Australia	+61	{9}	\N	t
BD	Bangladesh	+880	{10}	\N	t
BE	Belgium	+32	{9}	\N	t
BH	Bahrain	+973	{8}	\N	t
BR	Brazil	+55	{10,11}	\N	t
BT	Bhutan	+975	{8}	\N	t
CA	Canada	+1	{10}	\N	t
CH	Switzerland	+41	{9}	\N	t
CL	Chile	+56	{9}	\N	t
CN	China	+86	{11}	\N	t
CO	Colombia	+57	{10}	\N	t
CZ	Czechia	+420	{9}	\N	t
DE	Germany	+49	{10,11}	\N	t
DK	Denmark	+45	{8}	\N	t
DZ	Algeria	+213	{9}	\N	t
EG	Egypt	+20	{10}	\N	t
ES	Spain	+34	{9}	\N	t
ET	Ethiopia	+251	{9}	\N	t
FI	Finland	+358	{9}	\N	t
FR	France	+33	{9}	\N	t
GB	United Kingdom	+44	{10,11}	1	t
GH	Ghana	+233	{9}	\N	t
GR	Greece	+30	{10}	\N	t
HK	Hong Kong	+852	{8}	\N	t
HU	Hungary	+36	{9}	\N	t
ID	Indonesia	+62	{}	\N	t
IE	Ireland	+353	{9}	\N	t
IL	Israel	+972	{9}	\N	t
IN	India	+91	{10}	4	t
IQ	Iraq	+964	{10}	\N	t
IT	Italy	+39	{9,10}	\N	t
JO	Jordan	+962	{9}	\N	t
JP	Japan	+81	{10}	\N	t
KE	Kenya	+254	{9}	\N	t
KR	South Korea	+82	{9,10}	\N	t
KW	Kuwait	+965	{8}	\N	t
LB	Lebanon	+961	{7,8}	\N	t
LK	Sri Lanka	+94	{9}	\N	t
MA	Morocco	+212	{9}	\N	t
MU	Mauritius	+230	{8}	\N	t
MV	Maldives	+960	{7}	\N	t
MX	Mexico	+52	{10}	\N	t
MY	Malaysia	+60	{9,10}	\N	t
NG	Nigeria	+234	{10}	\N	t
NL	Netherlands	+31	{9}	\N	t
NO	Norway	+47	{8}	\N	t
NP	Nepal	+977	{10}	\N	t
NZ	New Zealand	+64	{8,9}	\N	t
OM	Oman	+968	{8}	\N	t
PE	Peru	+51	{9}	\N	t
PH	Philippines	+63	{10}	\N	t
PK	Pakistan	+92	{10}	\N	t
PL	Poland	+48	{9}	\N	t
PT	Portugal	+351	{9}	\N	t
QA	Qatar	+974	{8}	\N	t
RO	Romania	+40	{9}	\N	t
RU	Russia	+7	{10}	\N	t
SA	Saudi Arabia	+966	{9}	3	t
SE	Sweden	+46	{9}	\N	t
SG	Singapore	+65	{8}	\N	t
TH	Thailand	+66	{9}	\N	t
TN	Tunisia	+216	{8}	\N	t
TR	Türkiye	+90	{10}	\N	t
TW	Taiwan	+886	{9}	\N	t
TZ	Tanzania	+255	{9}	\N	t
UA	Ukraine	+380	{9}	\N	t
UG	Uganda	+256	{9}	\N	t
US	United States	+1	{10}	2	t
VN	Vietnam	+84	{9}	\N	t
ZA	South Africa	+27	{9}	\N	t
\.

-- crm.knowledge — 11 rows
COPY crm.knowledge ("id", "intent", "label", "answer", "active", "updated_at") FROM stdin;
047ff241-cf95-4423-8d86-5f9c76afc6f3	duration	how long a session takes	A first consultation runs about 60 minutes. Follow-ups are shorter.	t	2026-08-13 04:59:25.637861+05:30
4e11e1fd-2737-4f7f-957f-03081759b163	who-are-you	Who are you?	I am khadija, hope you are doing great. Let's connect, I'll be able help you.	t	2026-08-14 14:54:40.960212+05:30
4eac923d-b12c-4434-83e1-58497893c2b5	fallback	when the desk does not know	I can book you a consultation, tell you what she works with, or answer questions about how the sessions run. If it is something else, say so and she will pick it up herself.	t	2026-08-14 14:47:03.905025+05:30
6a932329-dc4d-43c8-9d5e-1554006a5315	services	what she works with	We work with {focusAreas}.\n\nIt's medical nutrition therapy, built around your labs, your routine and the food you actually eat.	t	2026-08-14 14:34:51.052763+05:30
70e034b4-cdce-47b3-a802-0789b02f93c4	fees	the fee	Fees depend on which programme suits you, so she sets them out herself rather than my quoting a number that turns out to be wrong. Send a request and she'll cover it in her reply.	t	2026-08-13 04:59:27.359162+05:30
78339385-cd2a-406c-b4e0-66e216b6674f	mode	video, phone or in person	Both — video call, phone, or in person. Most people outside the city choose video, and it works just as well. You can tell me which you'd prefer when I take your details.	t	2026-08-14 11:54:12.088209+05:30
a0a73505-0fe7-4968-8aeb-c6f8c3e51dca	location	where she is	Both — video call, phone, or in person. Most people outside the city choose video, and it works just as well. You can tell me which you'd prefer when I take your details.	t	2026-08-14 11:54:10.12428+05:30
a569b6c0-e88b-461b-b394-f12ee6d0e956	hours	opening hours	Consultation hours are {hours}. {presence}.	t	2026-08-14 11:54:03.132291+05:30
afd04dc7-7279-4a67-9960-f89a40b54269	about	about Khadija	Khadija is a clinical dietitian and sports nutritionist. She takes on a limited number of clients so each one gets real attention — which is why this is by appointment.	t	2026-08-14 11:53:42.071035+05:30
f24d7c45-368c-495a-88b8-3f63f5066b8a	process	how the sessions run	You send a request here with a few times that suit you. She replies personally — usually within {replyWindow} — confirms one of them, and takes it from there.\n\nThe first session is the long one: history, labs, lifestyle and goals, before any plan exists.	t	2026-08-14 11:54:13.35816+05:30
fbef2c09-cdca-4ac0-86ba-a0c1978aa362	human	speaking to a person	I'm the front desk — software, not Khadija. I take your details and find a time; she reads every request herself and replies personally.\n\nIf you'd rather skip me entirely, email {email} and she'll pick it up directly.	t	2026-08-14 11:54:03.767579+05:30
\.

-- crm.phrasings: nothing

-- crm.prices: nothing

-- crm.bot_switches — 2 rows
COPY crm.bot_switches ("bot", "enabled", "note", "changed_at") FROM stdin;
desk-officer	t	\N	2026-08-14 09:54:25.347418+05:30
front-desk	t	\N	2026-08-14 11:42:09.419331+05:30
\.

-- public.availability_rules — 12 rows
COPY public.availability_rules ("id", "weekday", "starts_min", "ends_min", "effective_from", "effective_to", "created_at") FROM stdin;
15e51231-bd94-4635-9b76-a30bd93d911a	2	600	780	2026-08-16	\N	2026-08-16 17:16:28.751563+05:30
1f512e8d-51fd-42f4-a925-986c6fa97b42	4	840	1140	2026-08-16	\N	2026-08-16 17:16:28.751563+05:30
25f97bdd-9718-4659-b57f-8b22bccecacb	1	840	1140	2026-08-16	\N	2026-08-16 17:16:28.751563+05:30
5e0b81ca-7c4f-45fe-a886-6b427c70d169	5	600	780	2026-08-16	\N	2026-08-16 17:16:28.751563+05:30
5ed40dc5-54fc-4d9e-bf44-5c72e6c41cd6	6	600	780	2026-08-16	\N	2026-08-16 17:16:28.751563+05:30
67f4680c-9141-4ad0-8be1-86c542feb962	6	840	1020	2026-08-16	\N	2026-08-16 17:16:28.751563+05:30
6a81f81a-4e32-487c-99d9-ebcc9dc419c4	4	600	780	2026-08-16	\N	2026-08-16 17:16:28.751563+05:30
94695156-ef18-447b-b7a7-093cc22b53f2	3	600	780	2026-08-16	\N	2026-08-16 17:16:28.751563+05:30
9e60c65c-8ee7-4cbc-a97b-bb4c50220f8e	5	840	1140	2026-08-16	\N	2026-08-16 17:16:28.751563+05:30
a1a6806d-a944-4a9b-92e2-80aa25c4e289	3	840	1140	2026-08-16	\N	2026-08-16 17:16:28.751563+05:30
a7fa61d0-9397-402e-9219-f1598fdca415	1	600	780	2026-08-16	\N	2026-08-16 17:16:28.751563+05:30
c6469364-ccc7-4050-8cb4-f3dcf281820c	2	840	1140	2026-08-16	\N	2026-08-16 17:16:28.751563+05:30
\.

-- public.availability_exceptions — 2 rows
COPY public.availability_exceptions ("id", "on_date", "kind", "starts_min", "ends_min", "reason", "created_at") FROM stdin;
835f710c-8467-4256-a467-515db0a8fe74	2026-08-19	closed	\N	\N	Conference	2026-08-15 01:24:20.283941+05:30
9017b236-9267-4e28-bdae-abb5202aed0c	2026-08-15	closed	\N	\N	Away	2026-08-14 11:58:29.780945+05:30
\.

COMMIT;
