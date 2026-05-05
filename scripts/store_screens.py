"""
Generate App Store / Play Store ready screenshots of the Compass app.

Output sizes:
  - App Store 6.7" iPhone (iPhone 15/16 Pro Max):  1290 x 2796  <-- also valid for 6.5"
  - Play Store Phone:                              1080 x 1920

For each size we produce a series of screenshots covering key screens.
"""
import asyncio
import os
import shutil
from playwright.async_api import async_playwright

URL = "http://localhost:3000"
OUT = "/app/scripts/output/store_assets"

# Each preset defines the final physical resolution.
# We render at point-size viewport and rely on device_scale_factor to get the final px.
PRESETS = [
    {
        "name": "ios_6_7",
        "viewport": {"width": 430, "height": 932},  # iPhone 15 Pro Max points
        "dsf": 3,  # -> 1290x2796 physical px
        "label": "App Store 6.7\" (1290x2796)",
    },
    {
        "name": "play_store",
        "viewport": {"width": 360, "height": 640},
        "dsf": 3,  # -> 1080x1920 physical px
        "label": "Play Store Phone (1080x1920)",
    },
]


async def capture_screen(page, path):
    await page.wait_for_timeout(800)
    await page.screenshot(path=path, full_page=False, type="png")


async def scroll_container(page, test_id, y):
    try:
        el = page.get_by_test_id(test_id)
        await el.evaluate(f"el => el.scrollTo({{top: {y}, behavior: 'instant'}})")
    except Exception:
        pass


async def reset_and_back_home(page):
    """Click Bussola tab to go home and reset state."""
    try:
        await page.get_by_text("Bussola", exact=True).click(force=True)
        await page.wait_for_timeout(700)
    except Exception:
        pass


async def capture_preset(browser, preset):
    out_dir = os.path.join(OUT, preset["name"])
    os.makedirs(out_dir, exist_ok=True)

    context = await browser.new_context(
        viewport=preset["viewport"],
        device_scale_factor=preset["dsf"],
    )
    page = await context.new_page()
    await page.goto(URL, wait_until="networkidle", timeout=30000)
    await page.wait_for_timeout(4000)

    # 01 — Home (hero + input + app della settimana)
    await capture_screen(page, os.path.join(out_dir, "01_home.png"))

    # 02 — Categorie in primo piano (scroll giù)
    await scroll_container(page, "home-scroll", 420)
    await capture_screen(page, os.path.join(out_dir, "02_categories.png"))

    # back to top
    await scroll_container(page, "home-scroll", 0)
    await page.wait_for_timeout(500)

    # 03 — Type a query & submit, wait result
    try:
        prompt = page.get_by_test_id("prompt-input")
        await prompt.click()
        await prompt.fill("voglio editare un video con sottotitoli")
        await page.wait_for_timeout(400)
        await page.get_by_test_id("submit-btn").click(force=True)
        # wait up to 40s for AI
        try:
            await page.wait_for_selector(
                '[data-testid="results-section"]', timeout=40000, state="visible"
            )
        except Exception:
            pass
        await page.wait_for_timeout(2500)
        await capture_screen(page, os.path.join(out_dir, "03_results.png"))

        # 04 — Results scrolled (pros/cons/share)
        await scroll_container(page, "home-scroll", 650)
        await capture_screen(page, os.path.join(out_dir, "04_results_scrolled.png"))
    except Exception as e:
        print(f"[{preset['name']}] results capture failed: {e}")

    # 05 — Cronologia tab
    try:
        await page.get_by_text("Cronologia", exact=True).click(force=True)
        await page.wait_for_timeout(1800)
        await capture_screen(page, os.path.join(out_dir, "05_history.png"))
    except Exception as e:
        print(f"[{preset['name']}] history failed: {e}")

    # 06 — Salvate tab
    try:
        await page.get_by_text("Salvate", exact=True).click(force=True)
        await page.wait_for_timeout(1500)
        await capture_screen(page, os.path.join(out_dir, "06_saved.png"))
    except Exception as e:
        print(f"[{preset['name']}] saved failed: {e}")

    await context.close()
    print(f"✅ {preset['label']} -> {out_dir}")


async def main():
    # clean
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"]
        )
        for preset in PRESETS:
            await capture_preset(browser, preset)
        await browser.close()

    # summary
    print("\nGenerated files:")
    for preset in PRESETS:
        dir_ = os.path.join(OUT, preset["name"])
        if os.path.isdir(dir_):
            for f in sorted(os.listdir(dir_)):
                path = os.path.join(dir_, f)
                size = os.path.getsize(path)
                print(f"  {preset['name']}/{f}  ({size/1024:.0f} KB)")


if __name__ == "__main__":
    asyncio.run(main())
