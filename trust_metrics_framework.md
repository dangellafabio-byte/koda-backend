# Koda Trust Metrics Framework

## The North Star Question
"If all push notifications were disabled tomorrow, how many users would return voluntarily?"

## Observable Trust Indicators (Calculated from Event Logs)

1. OPT-IN RATE (Check-in Value)
   - Formula: [Accepted Check-ins] / [Total Offered Check-ins]
   - Target: High stable rate. If it drops, the Decision Engine is becoming noisy or intrusive.

2. DETOX COMPLETION RATE (Autonomy Validation)
   - Formula: [Users who return spontaneously within 48h after detox_until expires] / [Total Users who activated Detox]
   - Target: High recovery. Validates that the return is conscious and not driven by digital dependency.

3. NEGATIVE FEEDBACK RATE (Invasiveness Index)
   - Formula: [Clicks on "Non era il momento giusto"] / [Total Proactive Initiatives Offered]
   - Target: Must be kept strictly under 5%.

4. TRUST RECOVERY RATE (Graceful Failure Effectiveness)
   - Formula: [Users who record a new session within 7 days after a NEGATIVE_FEEDBACK event] / [Total Users who triggered NEGATIVE_FEEDBACK]
   - Target: High retention post-error. Measures Koda's capacity to restore trust by stepping back.

5. PERCEIVED VALUE SCORE (PVS - Periodic Survey)
   - Run via a single-question in-app survey every 60-90 days to active users:
     *"Quanto sarebbe stato più difficile affrontare le tue sfide o i tuoi obiettivi personali negli ultimi mesi senza il supporto di Koda?"*
   - Target: Maintain a high volume of "Significativamente più difficile". If it drops while behavioral metrics are perfect, the system is becoming too passive/forgettable.
