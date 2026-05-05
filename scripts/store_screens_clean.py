"""
Generate CLEAN screenshots — without the bottom tab bar visible.
Hides the tab bar via CSS so only the app content is captured.
"""
import asyncio
import os
import shutil
from playwright.async_api import async_playwright

URL = "http://localhost:3000"
OUT = "/app/scripts/output/store_assets_clean"

# CSS injected to hide the bottom tab bar
HIDE_TABBAR_CSS = """
[role="tablist"] { display: none !important; }
[role="tab"] { display: none !important; }
"""

PRESETS = [
    {
        "name": "iphone_1284x2778_clean",
        "viewport": {"width": 428, "height": 926},
        "dsf": 3,  # -> 1284x2778 physical px (iPhone 13/14 Pro Max)
        "label": "iPhone 1284x2778 CLEAN",
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


async def navigate_route(page, route):
    """Use expo-router programmatic navigation by changing URL hash/path."""
    await page.evaluate(f"window.history.pushState({{}}, '', '{route}'); window.dispatchEvent(new PopStateEvent('popstate'));")
    await page.wait_for_timeout(1500)


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

    # Inject CSS to hide tab bar BEFORE taking screenshots
    await page.add_style_tag(content=HIDE_TABBAR_CSS)
    await page.wait_for_timeout(400)

    # 01 — Home (hero + input + app della settimana)
    await capture_screen(page, os.path.join(out_dir, "01_home.png"))

    # 02 — Categorie (scroll giù)
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
        try:
            await page.wait_for_selector(
                '[data-testid="results-section"]', timeout=45000, state="visible"
            )
        except Exception:
            pass
        await page.wait_for_timeout(2500)
        # re-inject CSS in case it got lost
        await page.add_style_tag(content=HIDE_TABBAR_CSS)
        await capture_screen(page, os.path.join(out_dir, "03_results.png"))

        # 04 — Results scrolled
        await scroll_container(page, "home-scroll", 650)
        await capture_screen(page, os.path.join(out_dir, "04_results_scrolled.png"))
    except Exception as e:
        print(f"[{preset['name']}] results capture failed: {e}")

    # 05 — History page (programmatic navigation since tab bar is hidden)
    try:
        await navigate_route(page, "/history")
        await page.add_style_tag(content=HIDE_TABBAR_CSS)
        await page.wait_for_timeout(1500)
        await capture_screen(page, os.path.join(out_dir, "05_history.png"))
    except Exception as e:
        print(f"[{preset['name']}] history failed: {e}")

    # 06 — Saved page
    try:
        await navigate_route(page, "/saved")
        await page.add_style_tag(content=HIDE_TABBAR_CSS)
        await page.wait_for_timeout(1500)
        await capture_screen(page, os.path.join(out_dir, "06_saved.png"))
    except Exception as e:
        print(f"[{preset['name']}] saved failed: {e}")

    await context.close()
    print(f"OK {preset['label']} -> {out_dir}")


async def main():
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

    print("\nGenerated CLEAN files:")
    for preset in PRESETS:
        dir_ = os.path.join(OUT, preset["name"])
        if os.path.isdir(dir_):
            for f in sorted(os.listdir(dir_)):
                path = os.path.join(dir_, f)
                size = os.path.getsize(path)
                print(f"  {preset['name']}/{f}  ({size/1024:.0f} KB)")


if __name__ == "__main__":
    asyncio.run(main())
