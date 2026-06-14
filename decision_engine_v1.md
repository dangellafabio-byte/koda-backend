# Koda Decision Engine - V1 Architecture & Philosophy

## Core Pillars
- **Principle #1 (User Agency):** Koda never decides what is best for the user. Koda only decides what support can be offered. The user always retains 100% agency.
- **Principle #2 (Explainable Support):** Whenever Koda offers support proactively, it must explain why, keeping the explanation human, clear, and non-technical.
- **Principle #3 (Humility by Design):** Koda never presumes to know the user's exact emotional state. It uses conditional and respectful language (e.g., "If you are going through a busy time...", never "You look stressed").
- **Principle #4 (Graceful Failure):** Koda assumes it can be wrong. When an initiative is dismissed or rejected, Koda steps back immediately without defending its algorithm.

## The Middleware: UserContext (Volatile RAM Object)
To avoid messy database queries, all decisions ingest a unified, non-persistent 'UserContext' generated on the fly in RAM:
- user_id: ObjectId
- interaction_signals: Dict (Frequency, timing, and velocity of recent interactions)
- reflection_signals: Dict (Triggers based on persistent memory engagement)
- silence_days: Integer (NOW - last_interaction_at)
- generated_at: Timestamp

## Decision Engine Matrix (Output Schema)
Every proactive output must separate technical telemetry (`internal_reason`) from user-facing text (`user_reason`) to avoid the "surveillance effect":

- INPUTS: [detox_until, silence_days, recent_interactions]
- OUTPUTS:
  1. DO_NOTHING (Default state: respect user's space)
  2. OFFER_CHECKIN -> {
       "action": "OFFER_CHECKIN",
       "internal_reason": { "silence_days": 6, "last_checkin_days": 14 },
       "user_reason": "È da qualche giorno che non ci sentiamo e volevo lasciarti un saluto."
     }
  3. OFFER_SPACE -> {
       "action": "OFFER_SPACE",
       "internal_reason": { "interaction_velocity_peak": true, "session_count_24h": 5 },
       "user_reason": "Abbiamo fatto diverse sessioni intense di recente. Volevo solo ricordarti che, se ne senti il bisogno, puoi staccare dallo schermo in qualsiasi momento."
     }
  4. OFFER_REFLECTION -> {
       "action": "OFFER_REFLECTION",
       "internal_reason": { "memory_trigger_matched": "lavoro", "days_passed": 7 },
       "user_reason": "Nelle scorse settimane accennavi a un impegno importante che avevi a cuore; se ti va di riprenderlo per fare il punto, io sono qui."
     }

## Feedback & Adaptation Loop
Every proactive action triggers an event tracked in the logs: ACCEPTED, DISMISSED, or NEGATIVE_FEEDBACK ("Non era il momento giusto").
- **Constraint:** If an action (e.g., OFFER_REFLECTION) receives 3 consecutive DISMISSED or NEGATIVE_FEEDBACK outcomes, the Decision Engine must automatically suppress that specific output, forcing it to DO_NOTHING for a 30-day cool-down period.
