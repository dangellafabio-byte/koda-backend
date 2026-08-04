"""
generate_stone_mockups.py — Genera 6 varianti di sfondo "grigio sasso"
per il tema giorno di Koda (2026-08-04, richiesta Fabio).

Perché esiste:
Fabio vuole sostituire lo sfondo crema attuale (screenshot 2026-08-04) con
uno sfondo che ricordi la pietra naturale, dal grigio chiarissimo (marmo)
fino all'antracite (basalto), con texture granulosa/puntinata.

Vincolo estetico: l'orb centrale è champagne #E8D9B8 e il NeonBorder è
champagne. Il sasso quindi deve avere sottotoni CALDI (grigi con touch di
terra/beige), NON grigi freddi/blu → altrimenti crea stridore visivo con
gli elementi champagne che restano al centro/perimetro.

Output: 6 PNG in /app/backend/static/theme_mockups/ (in formato 9:16
verticale mobile). Poi Fabio le guarda e sceglie quella che preferisce.
"""
import asyncio
import base64
import os
import sys
from pathlib import Path
from dotenv import load_dotenv
from emergentintegrations.llm.chat import LlmChat, UserMessage

load_dotenv("/app/backend/.env")

API_KEY = os.getenv("EMERGENT_LLM_KEY")
if not API_KEY:
    print("ERROR: EMERGENT_LLM_KEY not found in /app/backend/.env")
    sys.exit(1)

OUTPUT_DIR = Path("/app/backend/static/theme_mockups")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Le 6 varianti — dal chiarissimo al più scuro, sempre con sottotono caldo.
# I prompt sono deliberatamente descrittivi (Nano Banana ama i dettagli
# tattili) e menzionano SEMPRE "warm undertone" per evitare grigi freddi.
VARIANTS = [
    {
        "id": "01_marmo_perla",
        "prompt": (
            "A high-resolution photograph of a smooth pale grey stone surface, "
            "like polished marble with very subtle warm beige undertones, "
            "almost off-white with a hint of champagne. Fine natural veining, "
            "gentle grain texture visible on close inspection, soft diffuse "
            "natural daylight, no shadows, minimal aesthetic, meditative and "
            "calming feel. Vertical composition 9:16 mobile aspect ratio. "
            "The surface should feel serene, luxurious, tactile. No text, "
            "no objects, just the stone texture filling the entire frame."
        ),
    },
    {
        "id": "02_arenaria_chiara",
        "prompt": (
            "A high-resolution photograph of a light warm grey sandstone "
            "surface, natural stone with visible fine grain pointillism, "
            "sandy dotted texture, warm undertones (light taupe, subtle "
            "cream-grey), like natural limestone found in Mediterranean "
            "villages. Even soft daylight, no harsh shadows. Vertical 9:16 "
            "mobile aspect ratio. Peaceful, natural, understated luxury. "
            "No text, no objects, texture fills the entire frame."
        ),
    },
    {
        "id": "03_pietra_grezza_media",
        "prompt": (
            "A high-resolution photograph of medium warm grey natural stone, "
            "raw pietra serena with visible granular pointillism, small dark "
            "and light speckles scattered naturally across the surface, "
            "matte finish, sophisticated warm undertone (like Tuscan stone), "
            "even natural daylight. Vertical 9:16 mobile aspect ratio. "
            "Feels grounded, elegant, timeless. No text, no objects, texture "
            "fills the entire frame."
        ),
    },
    {
        "id": "04_ardesia_calda",
        "prompt": (
            "A high-resolution photograph of a dark warm grey slate stone "
            "surface, deep charcoal with warm brownish undertones (not cold "
            "blue-grey), subtle granulated pointillism, dark mineral speckles "
            "in different micro-tones creating natural depth, matte finish, "
            "soft directional daylight revealing surface topography without "
            "harsh contrast. Vertical 9:16 mobile aspect ratio. Feels "
            "intimate, sophisticated, meditative. No text, no objects, "
            "texture fills the entire frame."
        ),
    },
    {
        "id": "05_pietra_lavica",
        "prompt": (
            "A high-resolution photograph of a very dark grey volcanic stone "
            "surface, basalt or lava rock with warm tones (avoiding pure "
            "black), pronounced fine granular pointillism, tiny lighter and "
            "darker specks scattered across the surface creating a starry "
            "night quality on stone, matte finish, soft dim ambient lighting "
            "that shows the mineral texture. Vertical 9:16 mobile aspect "
            "ratio. Feels deep, contemplative, night-like. No text, no "
            "objects, texture fills the entire frame."
        ),
    },
    {
        "id": "06_antracite_notturno",
        "prompt": (
            "A high-resolution photograph of a near-black warm anthracite "
            "stone surface with visible mineral pointillism, warm dark grey "
            "(not cold blue-black), micro-specks of slightly lighter grey and "
            "warm brown scattered like distant stars on stone, matte "
            "finish, extremely soft ambient light revealing subtle texture "
            "depth without harsh contrast. Vertical 9:16 mobile aspect ratio. "
            "Feels like deep quiet night, intimate. No text, no objects, "
            "texture fills the entire frame."
        ),
    },
]


async def generate_variant(idx: int, variant: dict):
    """Genera una singola variante — nuova session per ogni chiamata."""
    print(f"\n[{idx+1}/{len(VARIANTS)}] Generating: {variant['id']}...")
    print(f"       Prompt: {variant['prompt'][:80]}...")

    chat = LlmChat(
        api_key=API_KEY,
        session_id=f"stone-mockup-{variant['id']}",
        system_message="You are a professional photographer specialized in "
                       "minimal, tactile texture photography for mobile app "
                       "backgrounds.",
    )
    chat.with_model("gemini", "gemini-3.1-flash-image-preview")
    chat.with_params(modalities=["image", "text"])

    msg = UserMessage(text=variant["prompt"])

    try:
        text, images = await chat.send_message_multimodal_response(msg)
        if not images:
            print(f"       FAILED — no images returned. Text: {text[:100]}")
            return None
        img = images[0]
        image_bytes = base64.b64decode(img["data"])
        out_path = OUTPUT_DIR / f"{variant['id']}.png"
        out_path.write_bytes(image_bytes)
        size_kb = out_path.stat().st_size / 1024
        print(f"       OK — saved {out_path.name} ({size_kb:.1f} KB, "
              f"mime={img.get('mime_type', '?')})")
        return out_path
    except Exception as e:
        print(f"       ERROR: {type(e).__name__}: {e}")
        return None


async def main():
    print("=" * 70)
    print("STONE MOCKUPS GENERATOR — Koda day theme (2026-08-04)")
    print(f"Output: {OUTPUT_DIR}")
    print(f"Variants: {len(VARIANTS)}")
    print("=" * 70)

    results = []
    for idx, variant in enumerate(VARIANTS):
        result = await generate_variant(idx, variant)
        results.append((variant["id"], result))
        # Piccola pausa per non stressare l'API in caso di rate limit
        await asyncio.sleep(1.5)

    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)
    ok_count = sum(1 for _, r in results if r is not None)
    fail_count = len(results) - ok_count
    for vid, r in results:
        status = "✅" if r else "❌"
        print(f"  {status}  {vid}")
    print(f"\nTotal: {ok_count}/{len(results)} OK, {fail_count} failed")
    if ok_count > 0:
        print(f"\nFiles saved to: {OUTPUT_DIR}")
        print("Serve them via /api/theme_mockups/{filename} (aggiungeremo endpoint)")


if __name__ == "__main__":
    asyncio.run(main())
