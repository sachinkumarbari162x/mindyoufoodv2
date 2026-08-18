"""The guardrail, and who it is guarding.

Run:  python services/py-ai/test_guardrails.py

WHY THIS FILE EXISTS. The clinical rule was relaxed for one
audience — Khadija reading her own diary — because "you have one
waiting for diabetes care" was being refused as a diagnosis and
blanking her morning briefing three times in five.

Relaxing a safety rule needs a test that says exactly how far, or
the next person to touch it has only a comment to go on. Every
line below is either something this software must never say, or
something it was wrongly refusing to say.
"""
import sys

import guardrails as g

CASES = [
    # (text, audience, should_pass, what it is)
    ("You have one waiting for diabetes care today.", "practitioner", True,
     "her queue — the false positive that blanked the briefing"),
    ("You have two holds expiring and a diabetes review at 2pm.", "practitioner", True,
     "her day, read back to her"),
    ("You have diabetes and should start metformin.", "practitioner", False,
     "advice — relaxing the rule must not reach this"),
    ("You have diabetes; increase her insulin.", "practitioner", False,
     "advice, phrased as a note"),
    ("Take 500 mg twice a day.", "practitioner", False, "a dosage"),
    ("Your labs show elevated fasting glucose.", "practitioner", False, "reading labs"),
    ("Aim for 1800 kcal a day.", "practitioner", False, "a calorie target"),

    ("You have diabetes.", "visitor", False,
     "the front desk diagnosing a stranger"),
    ("You have diabetes care booked with her.", "visitor", False,
     "only her side is relaxed, never the desk's"),
    ("You mentioned you have PCOS — noted.", "visitor", True,
     "an echo of what the visitor said — this was broken by a literal "
     "backspace where \b was meant, so it never matched at all"),
    ("She has two free hours on Thursday.", "visitor", True, "ordinary desk talk"),
]


def main() -> int:
    bad = 0
    for text, audience, want, what in CASES:
        ok, _, reason = g.check_reply(text, audience=audience)
        good = ok == want
        bad += not good
        state = "passes" if ok else f"blocked({reason})"
        print(f"  {'ok  ' if good else 'FAIL'} [{audience:12s}] {state:18s} {what}")

    # A pattern with a literal backspace in it silently matches
    # nothing, which is how ACKNOWLEDGEMENT sat dead. Cheap to check,
    # and it fails loudly the next time an editor eats a backslash.
    for name in ("ACKNOWLEDGEMENT", "CONDITIONS", "PRICE", "ADVICE"):
        pat = getattr(g, name, None)
        if pat is not None and "\x08" in pat.pattern:
            bad += 1
            print(f"  FAIL {name} contains a literal backspace where \b was meant")
    for group in ("CLINICAL", "LEAKAGE", "OVERPROMISE"):
        for i, pat in enumerate(getattr(g, group, [])):
            if "\x08" in pat.pattern:
                bad += 1
                print(f"  FAIL {group}[{i}] contains a literal backspace")

    print(f"\n  {len(CASES) - bad}/{len(CASES)} as intended")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
