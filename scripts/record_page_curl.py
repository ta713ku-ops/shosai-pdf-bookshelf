from pathlib import Path
import sys

OUTPUT = Path("/tmp/shosai-page-curl-demo.gif")
FRAMES = Path("/tmp/shosai-page-curl-frames")


def capture_browser_frames() -> None:
    sys.path.insert(0, "/tmp/shosai-playwright")
    from playwright.sync_api import sync_playwright
    from verify_app import make_pdf

    app_url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4318"
    errors: list[str] = []
    FRAMES.mkdir(parents=True, exist_ok=True)
    for old_frame in FRAMES.glob("frame-*.png"):
        old_frame.unlink()
    frame_number = 0

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path="/Users/taku/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell",
        )
        context = browser.new_context(viewport={"width": 1180, "height": 820}, device_scale_factor=1, has_touch=True)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
        page.on("console", lambda message: errors.append(f"console.{message.type}: {message.text}") if message.type == "error" else None)
        page.goto(app_url, wait_until="networkidle")
        page.locator('input[type="file"]').set_input_files({
            "name": "page-curl-demo.pdf",
            "mimeType": "application/pdf",
            "buffer": make_pdf(6),
        })
        page.get_by_role("button", name="page-curl-demoを開く。1/6ページ").wait_for(timeout=20_000)
        page.get_by_role("button", name="page-curl-demoを開く。1/6ページ").click()
        page.get_by_role("img", name="1ページ").wait_for(timeout=20_000)
        page.get_by_role("img", name="2ページ").wait_for(timeout=20_000)

        def capture(repeat: int = 1) -> None:
            nonlocal frame_number
            source = page.screenshot(type="png")
            for _ in range(repeat):
                (FRAMES / f"frame-{frame_number:03d}.png").write_bytes(source)
                frame_number += 1

        capture(4)
        page.mouse.move(165, 625)
        page.mouse.down()
        progresses: list[float] = []
        for step in range(1, 15):
            x = 165 + (390 * step / 14)
            y = 625 - (62 * step / 14)
            page.mouse.move(x, y)
            curl = page.locator('.reader-turn-layer[data-turn-direction="forward"][data-turn-side="left"]')
            curl.wait_for(timeout=5_000)
            progresses.append(float(curl.evaluate("element => getComputedStyle(element).getPropertyValue('--reader-curl-progress')")))
            capture()

        if progresses != sorted(progresses) or progresses[-1] <= progresses[0]:
            raise AssertionError(f"Page curl did not follow the pointer: {progresses}")

        page.mouse.up()
        for _ in range(11):
            page.wait_for_timeout(66)
            capture()
        page.locator('.reader-pages[data-visible-pages="3,4"]').wait_for(timeout=5_000)
        page.get_by_role("img", name="4ページ").wait_for(timeout=5_000)
        if page.locator(".reader-page-message:visible").count():
            raise AssertionError("A loading placeholder remained after the forward page curl")
        capture(7)

        # Confirm that reversing the gesture returns to the first spread.
        page.mouse.move(800, 540)
        page.mouse.down()
        page.mouse.move(430, 500, steps=10)
        reverse = page.locator('.reader-turn-layer[data-turn-direction="backward"][data-turn-side="right"]')
        reverse.wait_for(timeout=5_000)
        page.mouse.up()
        page.locator('.reader-pages[data-visible-pages="1,2"]').wait_for(timeout=5_000)
        if page.locator(".reader-page-message:visible").count():
            raise AssertionError("A loading placeholder remained after returning to the previous spread")

        # Confirm the curl mirrors when the reading direction changes.
        page.locator(".reader-stage").click(position={"x": 590, "y": 410})
        page.get_by_label("本の開き方向").select_option("ltr")
        page.get_by_role("button", name="操作パネルを隠す").click()
        page.mouse.move(1010, 560)
        page.mouse.down()
        page.mouse.move(650, 520, steps=10)
        mirrored = page.locator('.reader-turn-layer[data-turn-direction="forward"][data-turn-side="right"]')
        mirrored.wait_for(timeout=5_000)
        page.mouse.up()
        page.locator('.reader-pages[data-visible-pages="3,4"]').wait_for(timeout=5_000)

        # Rapid taps during the settling animation must not cancel or strand it.
        page.locator(".reader-stage").click(position={"x": 590, "y": 410})
        page.get_by_label("ページ番号").fill("1")
        page.get_by_role("button", name="操作パネルを隠す").click()
        page.locator('.reader-pages[data-visible-pages="1,2"]').wait_for(timeout=5_000)
        for _ in range(6):
            page.mouse.click(1080, 410)
        page.wait_for_timeout(900)
        visible_pages = page.locator(".reader-pages").get_attribute("data-visible-pages")
        if visible_pages != "3,4" or page.locator(".reader-turn-layer").count():
            raise AssertionError(f"Rapid taps stranded the page turn: visible={visible_pages!r}")

        for expected, x in (("5,6", 1080), ("3,4", 100), ("1,2", 100)):
            for _ in range(12):
                page.mouse.click(x, 410)
            page.wait_for_timeout(900)
            visible_pages = page.locator(".reader-pages").get_attribute("data-visible-pages")
            if visible_pages != expected or page.locator(".reader-turn-layer").count():
                raise AssertionError(f"Rapid-tap stress turn failed: expected={expected!r} visible={visible_pages!r}")
            if page.locator(".reader-page-message:visible").count():
                raise AssertionError(f"Loading remained after rapid-tap stress turn to {expected}")
        browser.close()

    if errors:
        raise AssertionError(f"Browser errors: {errors}")

    print(f"Verified forward, reverse, and mirrored page curls. Captured {frame_number} browser frames.")


def assemble_gif() -> None:
    from PIL import Image

    paths = sorted(FRAMES.glob("frame-*.png"))
    if not paths:
        raise FileNotFoundError("No captured page-curl frames were found")
    frames: list[Image.Image] = []
    for path in paths:
        image = Image.open(path).convert("RGB")
        frames.append(image.resize((826, 574), Image.Resampling.LANCZOS))
    palette = frames[0].quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    encoded = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
    encoded[0].save(
        OUTPUT,
        save_all=True,
        append_images=encoded[1:],
        duration=68,
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"GIF: {OUTPUT} ({len(frames)} real browser frames)")


if __name__ == "__main__":
    if "--assemble" in sys.argv:
        assemble_gif()
    else:
        capture_browser_frames()
