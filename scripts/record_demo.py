"""
Records a screen demo of the App Compass app using Playwright.
Output: /app/scripts/output/compass_demo.webm and (optional) .mp4
"""
import asyncio
import os
import shutil
import subprocess
from playwright.async_api import async_playwright

OUTPUT_DIR = "/app/scripts/output"
URL = "http://localhost:3000"
VIEWPORT = {"width": 390, "height": 844}


async def type_slowly(page, selector_or_locator, text, delay=60):
    for ch in text:
        await selector_or_locator.type(ch, delay=delay)


async def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    # clear previous videos
    for f in os.listdir(OUTPUT_DIR):
        if f.endswith(".webm"):
            try:
                os.remove(os.path.join(OUTPUT_DIR, f))
            except OSError:
                pass

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = await browser.new_context(
            viewport=VIEWPORT,
            device_scale_factor=2,
            record_video_dir=OUTPUT_DIR,
            record_video_size=VIEWPORT,
        )
        page = await context.new_page()

        try:
            print(">> Navigate to app")
            await page.goto(URL, wait_until="networkidle", timeout=30000)
            await page.wait_for_timeout(3500)

            print(">> Pause on home")
            await page.wait_for_timeout(2500)

            print(">> Focus prompt input")
            prompt = page.get_by_test_id("prompt-input")
            await prompt.click()
            await page.wait_for_timeout(400)

            print(">> Type query")
            await type_slowly(page, prompt, "voglio editare un video", delay=55)
            await page.wait_for_timeout(900)

            print(">> Submit")
            await page.get_by_test_id("submit-btn").click(force=True)

            # wait for AI result (could take up to 25s)
            print(">> Waiting for results...")
            try:
                await page.wait_for_selector(
                    '[data-testid="results-section"]',
                    timeout=45000,
                    state="visible",
                )
            except Exception:
                print(">> Results selector not found, continue anyway")

            await page.wait_for_timeout(2500)

            print(">> Scroll through results")
            scroll = page.get_by_test_id("home-scroll")
            for y in (200, 500, 800, 1100, 1400):
                try:
                    await scroll.evaluate(
                        f"el => el.scrollTo({{top: {y}, behavior: 'smooth'}})"
                    )
                except Exception:
                    pass
                await page.wait_for_timeout(1400)

            print(">> Tap saved tab")
            try:
                await page.get_by_text("Salvate", exact=True).click(force=True)
                await page.wait_for_timeout(2500)
            except Exception as e:
                print(f"tab click failed: {e}")

            print(">> Tap history tab")
            try:
                await page.get_by_text("Cronologia", exact=True).click(force=True)
                await page.wait_for_timeout(2500)
            except Exception as e:
                print(f"tab click failed: {e}")

            print(">> Back to home")
            try:
                await page.get_by_text("Bussola", exact=True).click(force=True)
                await page.wait_for_timeout(2500)
            except Exception:
                pass

        finally:
            await context.close()
            await browser.close()

    # rename the webm to a friendly name
    produced = [f for f in os.listdir(OUTPUT_DIR) if f.endswith(".webm")]
    if produced:
        src = os.path.join(OUTPUT_DIR, produced[0])
        dst_webm = os.path.join(OUTPUT_DIR, "compass_demo.webm")
        shutil.move(src, dst_webm)
        print(f"WEBM ready: {dst_webm}")

        # convert to MP4 with ffmpeg if available
        if shutil.which("ffmpeg"):
            dst_mp4 = os.path.join(OUTPUT_DIR, "compass_demo.mp4")
            try:
                subprocess.run(
                    [
                        "ffmpeg", "-y", "-i", dst_webm,
                        "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-preset", "fast", "-crf", "23",
                        "-movflags", "+faststart",
                        dst_mp4,
                    ],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                print(f"MP4 ready: {dst_mp4}")
            except subprocess.CalledProcessError as e:
                print(f"MP4 conversion failed: {e}")

            # GIF preview (small)
            dst_gif = os.path.join(OUTPUT_DIR, "compass_demo.gif")
            try:
                subprocess.run(
                    [
                        "ffmpeg", "-y", "-i", dst_webm,
                        "-vf", "fps=12,scale=360:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
                        "-loop", "0",
                        dst_gif,
                    ],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                print(f"GIF ready: {dst_gif}")
            except subprocess.CalledProcessError as e:
                print(f"GIF conversion failed: {e}")
    else:
        print("ERROR: no video file produced")


if __name__ == "__main__":
    asyncio.run(main())
