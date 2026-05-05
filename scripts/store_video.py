"""
Record App Store Preview video at 886x1920 (portrait, iPhone 6.5"/6.7").
This is the exact resolution Apple requires for preview videos in that slot.

Also produces a 1080x1920 variant for Play Store.
"""
import asyncio
import os
import shutil
import subprocess
from playwright.async_api import async_playwright

URL = "http://localhost:3000"
OUTPUT_DIR = "/app/scripts/output/store_assets/video"

PRESETS = [
    {"name": "appstore_preview_886x1920", "viewport": {"width": 443, "height": 960}, "dsf": 2},  # -> 886x1920
    {"name": "playstore_preview_1080x1920", "viewport": {"width": 360, "height": 640}, "dsf": 3},  # -> 1080x1920
]


async def type_slowly(page, locator, text, delay=55):
    for ch in text:
        await locator.type(ch, delay=delay)


async def run_demo(page):
    await page.goto(URL, wait_until="networkidle", timeout=30000)
    await page.wait_for_timeout(3500)
    # hold on home
    await page.wait_for_timeout(2500)

    prompt = page.get_by_test_id("prompt-input")
    await prompt.click()
    await page.wait_for_timeout(300)
    await type_slowly(page, prompt, "voglio editare un video", delay=55)
    await page.wait_for_timeout(900)
    await page.get_by_test_id("submit-btn").click(force=True)

    # wait for results
    try:
        await page.wait_for_selector(
            '[data-testid="results-section"]',
            timeout=45000,
            state="visible",
        )
    except Exception:
        pass
    await page.wait_for_timeout(2500)

    # scroll results
    try:
        scroll = page.get_by_test_id("home-scroll")
        for y in (200, 500, 800, 1100, 1400):
            await scroll.evaluate(f"el => el.scrollTo({{top: {y}, behavior: 'smooth'}})")
            await page.wait_for_timeout(1300)
    except Exception:
        pass

    # tabs
    for tab in ("Salvate", "Cronologia", "Bussola"):
        try:
            await page.get_by_text(tab, exact=True).click(force=True)
            await page.wait_for_timeout(2200)
        except Exception:
            pass


async def record_preset(browser, preset):
    out_dir = os.path.join(OUTPUT_DIR, preset["name"])
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    vp = preset["viewport"]
    dsf = preset["dsf"]
    video_size = {"width": vp["width"] * dsf, "height": vp["height"] * dsf}

    context = await browser.new_context(
        viewport=vp,
        device_scale_factor=dsf,
        record_video_dir=out_dir,
        record_video_size=video_size,
    )
    page = await context.new_page()
    try:
        await run_demo(page)
    finally:
        await context.close()

    produced = [f for f in os.listdir(out_dir) if f.endswith(".webm")]
    if not produced:
        return None

    src_webm = os.path.join(out_dir, produced[0])
    final_webm = os.path.join(out_dir, f"{preset['name']}.webm")
    shutil.move(src_webm, final_webm)

    # convert to mp4
    final_mp4 = os.path.join(out_dir, f"{preset['name']}.mp4")
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", final_webm,
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-preset", "fast", "-crf", "20",
                "-vf", f"scale={video_size['width']}:{video_size['height']}",
                "-movflags", "+faststart",
                final_mp4,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError:
        pass

    return {
        "webm": final_webm,
        "mp4": final_mp4 if os.path.exists(final_mp4) else None,
        "size": f"{video_size['width']}x{video_size['height']}",
    }


async def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"]
        )
        results = {}
        for preset in PRESETS:
            print(f">> Recording {preset['name']} ...")
            res = await record_preset(browser, preset)
            results[preset["name"]] = res
            print(f"   done: {res}")
        await browser.close()

    print("\nSummary:")
    for name, info in results.items():
        print(f"  {name}: {info}")


if __name__ == "__main__":
    asyncio.run(main())
