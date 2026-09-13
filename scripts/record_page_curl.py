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
        if page.locator('.reader-pages[data-visible-pages="1"] > .reader-page').count() != 1:
            raise AssertionError("Landscape cover must be displayed alone")
        if page.get_by_role("img", name="2ページ").count():
            raise AssertionError("The first landscape screen incorrectly included page 2")

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
        for _ in range(19):
            page.wait_for_timeout(66)
            capture()
        page.locator('.reader-pages[data-visible-pages="2,3"]').wait_for(timeout=5_000)
        page.get_by_role("img", name="3ページ").wait_for(timeout=5_000)
        if page.locator(".reader-page-message:visible").count():
            raise AssertionError("A loading placeholder remained after the forward page curl")
        capture(7)

        # Confirm that reversing the gesture returns to the first spread.
        page.mouse.move(800, 540)
        page.mouse.down()
        page.mouse.move(430, 500, steps=10)
        reverse = page.locator('.reader-turn-layer[data-turn-direction="backward"][data-turn-side="right"]')
        reverse.wait_for(timeout=5_000)
        if reverse.locator('.reader-turn-front canvas[aria-label="2ページ"]').count() != 1:
            raise AssertionError("The landscape backward curl did not lift the current gutter page")
        if reverse.locator('.reader-turn-back canvas[aria-label="1ページ"]').count() != 1:
            raise AssertionError("The landscape backward curl did not expose the previous page on its reverse")
        if reverse.locator('.reader-turn-underlay canvas').count():
            raise AssertionError("The landscape cover curl rendered a duplicate page underneath")
        if reverse.locator('canvas[aria-label="1ページ"]').count() != 1:
            raise AssertionError("The landscape cover curl must contain exactly one cover leaf")
        if reverse.evaluate("element => getComputedStyle(element).backgroundColor") != "rgb(0, 0, 0)":
            raise AssertionError("The previous landscape spread was not concealed while closing the cover")
        page.mouse.up()
        page.wait_for_timeout(450)
        page.screenshot(path="/tmp/shosai-landscape-cover-return.png")
        if not reverse.is_visible():
            raise AssertionError("The backward curl disappeared before its paper motion could be seen")
        reverse_angle = reverse.locator(".reader-turn-sheet").evaluate("element => getComputedStyle(element).transform")
        if reverse_angle == "none":
            raise AssertionError("The backward curl did not apply a visible reverse transform")
        page.wait_for_timeout(850)
        page.locator('.reader-pages[data-visible-pages="1"]').wait_for(timeout=5_000)
        if page.locator('.reader-pages[data-visible-pages="1"] > .reader-page').count() != 1:
            raise AssertionError("Returning to the landscape cover left more than one visible page")
        if page.get_by_role("img", name="2ページ").count():
            raise AssertionError("A body page remained visible beside the landscape cover")
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
        page.locator('.reader-pages[data-visible-pages="2,3"]').wait_for(timeout=5_000)

        # Rapid taps during the settling animation must not cancel or strand it.
        page.locator(".reader-stage").click(position={"x": 590, "y": 410})
        page.get_by_label("ページ番号").fill("1")
        page.get_by_role("button", name="操作パネルを隠す").click()
        page.locator('.reader-pages[data-visible-pages="1"]').wait_for(timeout=5_000)
        for _ in range(6):
            page.mouse.click(1080, 410)
        page.wait_for_timeout(1400)
        visible_pages = page.locator(".reader-pages").get_attribute("data-visible-pages")
        if visible_pages != "2,3" or page.locator(".reader-turn-layer").count():
            raise AssertionError(f"Rapid taps stranded the page turn: visible={visible_pages!r}")

        for expected, x in (("4,5", 1080), ("6", 1080), ("4,5", 100), ("2,3", 100), ("1", 100)):
            for _ in range(12):
                page.mouse.click(x, 410)
            page.wait_for_timeout(1400)
            visible_pages = page.locator(".reader-pages").get_attribute("data-visible-pages")
            if visible_pages != expected or page.locator(".reader-turn-layer").count():
                raise AssertionError(f"Rapid-tap stress turn failed: expected={expected!r} visible={visible_pages!r}")
            if page.locator(".reader-page-message:visible").count():
                raise AssertionError(f"Loading remained after rapid-tap stress turn to {expected}")

        # The one-leaf cover close must also hold for a left-opening book.
        page.locator(".reader-stage").click(position={"x": 590, "y": 410})
        page.get_by_label("ページ番号").fill("2")
        page.get_by_role("button", name="操作パネルを隠す").click()
        page.mouse.click(100, 410)
        left_cover = page.locator('.reader-turn-layer.is-target-cover[data-turn-side="left"]')
        left_cover.wait_for(timeout=5_000)
        if left_cover.evaluate("element => getComputedStyle(element).backgroundColor") != "rgb(0, 0, 0)":
            raise AssertionError("The left-opening cover close exposed the previous spread")
        if left_cover.locator('canvas[aria-label="1ページ"]').count() != 1:
            raise AssertionError("The left-opening cover close did not contain exactly one cover")
        page.wait_for_timeout(1300)
        page.locator('.reader-pages[data-visible-pages="1"]').wait_for(timeout=5_000)

        # Portrait forward and backward turns must share one physical binding axis.
        page.set_viewport_size({"width": 820, "height": 1180})
        page.wait_for_timeout(300)
        page.locator(".reader-stage").click(position={"x": 410, "y": 590})
        page.get_by_label("ページ番号").fill("2")
        page.get_by_role("button", name="操作パネルを隠す").click()
        page.locator('.reader-pages[data-visible-pages="2"]').wait_for(timeout=5_000)

        page.mouse.move(700, 590)
        page.mouse.down()
        page.mouse.move(620, 590, steps=4)
        portrait_forward = page.locator('.reader-turn-layer[data-turn-direction="forward"][data-turn-axis="left"].is-single')
        portrait_forward.wait_for(timeout=5_000)
        page.mouse.up()
        page.wait_for_timeout(1300)

        page.mouse.move(120, 590)
        page.mouse.down()
        page.mouse.move(200, 590, steps=4)
        portrait_backward = page.locator('.reader-turn-layer[data-turn-direction="backward"][data-turn-axis="left"].is-single')
        portrait_backward.wait_for(timeout=5_000)
        if page.locator('.reader-turn-layer .reader-page-message:visible').count():
            raise AssertionError("Cached portrait pages flashed a loading placeholder when turning back")
        page.mouse.up()
        page.wait_for_timeout(1300)
        if page.locator('.reader-pages').get_attribute('data-visible-pages') != '2':
            raise AssertionError("Cancelled portrait axis checks changed the current page")

        page.evaluate("""() => {
          window.__portraitTurnFrames = [];
          const started = performance.now();
          const sample = () => {
            const layer = document.querySelector('.reader-turn-layer');
            const fold = layer?.querySelector('.reader-turn-portrait-fold');
            const underlay = layer?.querySelector('.reader-turn-underlay');
            const target = underlay?.querySelector('.reader-page');
            const foldRect = fold?.getBoundingClientRect();
            const underlayRect = underlay?.getBoundingClientRect();
            const targetRect = target?.getBoundingClientRect();
            const clipPath = underlay ? getComputedStyle(underlay).clipPath : 'none';
            const insetValues = clipPath.startsWith('inset(')
              ? clipPath.slice(6, -1).trim().split(/\s+/)
              : [];
            const toPixels = (value) => {
              if (!underlayRect || !value) return 0;
              return value.endsWith('%')
                ? Number.parseFloat(value) * underlayRect.width / 100
                : Number.parseFloat(value);
            };
            const horizontalInset = insetValues.length === 1 ? insetValues[0] : insetValues[1];
            const leftInset = insetValues.length >= 4 ? insetValues[3] : horizontalInset;
            const rightInset = horizontalInset;
            const revealEdge = !underlayRect || !insetValues.length
              ? null
              : underlayRect.left + (layer?.classList.contains('is-right')
                ? underlayRect.width - toPixels(rightInset)
                : toPixels(leftInset));
            const foldCenter = foldRect ? foldRect.left + foldRect.width / 2 : null;
            window.__portraitTurnFrames.push({
              elapsed: performance.now() - started,
              hasTurn: Boolean(layer),
              messageCount: document.querySelectorAll('.reader-turn-layer .reader-page-message').length,
              hasFold: Boolean(fold),
              foldCenter: foldCenter ?? 0,
              edgeGap: foldCenter === null || revealEdge === null ? 0 : Math.abs(foldCenter - revealEdge),
              targetLeft: targetRect?.left ?? 0,
              targetWidth: targetRect?.width ?? 0,
              clipPath: underlay ? getComputedStyle(underlay).clipPath : 'none',
            });
            if (performance.now() - started < 1500) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }""")
        page.mouse.click(25, 590)
        for index, delay in enumerate((150, 300, 350, 300)):
            page.wait_for_timeout(delay)
            page.screenshot(path=f"/tmp/shosai-portrait-backward-{index}.png")
        page.wait_for_timeout(400)
        portrait_frames = page.evaluate("window.__portraitTurnFrames")
        if any(frame["messageCount"] for frame in portrait_frames):
            raise AssertionError("Portrait backward turn inserted a transient loading frame")
        active_frames = [frame for frame in portrait_frames if frame["hasTurn"]]
        if len(active_frames) < 30:
            raise AssertionError(f"Portrait backward animation disappeared too early: {len(active_frames)} frames")
        if not all(frame["hasFold"] for frame in active_frames):
            raise AssertionError("Portrait backward turn lost its paper fold during the animation")
        if any(not frame["clipPath"].startswith("inset(") for frame in active_frames):
            raise AssertionError("Portrait backward turn used a polygon that can tear the page into triangular fragments")
        fold_centers = [frame["foldCenter"] for frame in active_frames]
        if max(fold_centers) - min(fold_centers) < 650:
            raise AssertionError("Portrait backward fold did not travel across the page")
        edge_gaps = [frame["edgeGap"] for frame in active_frames]
        if max(edge_gaps) > 14:
            raise AssertionError(f"Portrait backward fold detached from the revealed page edge: {max(edge_gaps):.1f}px")
        print(f"Portrait backward fold/reveal edge gap: {max(edge_gaps):.1f}px")
        clip_paths = {frame["clipPath"] for frame in active_frames if frame["clipPath"] != "none"}
        if len(clip_paths) < 8:
            raise AssertionError("Portrait backward page reveal did not follow the paper fold")
        target_lefts = [frame["targetLeft"] for frame in active_frames]
        target_widths = [frame["targetWidth"] for frame in active_frames]
        if max(target_lefts) - min(target_lefts) > 2 or min(target_widths) < 780:
            raise AssertionError("Portrait backward target page slid or warped instead of staying anchored")
        page.locator('.reader-pages[data-visible-pages="1"]').wait_for(timeout=5_000)

        # Mirror the incoming portrait page for the default right-opening mode.
        page.locator(".reader-stage").click(position={"x": 410, "y": 590})
        page.get_by_label("ページ番号").fill("2")
        page.get_by_label("本の開き方向").select_option("rtl")
        page.get_by_role("button", name="操作パネルを隠す").click()
        page.mouse.click(795, 590)
        rtl_backward = page.locator('.reader-turn-layer.is-portrait-backward[data-turn-side="left"]')
        rtl_backward.wait_for(timeout=5_000)
        if rtl_backward.get_attribute('data-turn-axis') != 'right':
            raise AssertionError("The right-opening portrait return used a different binding axis")
        if rtl_backward.locator('.reader-turn-underlay canvas[aria-label="1ページ"]').count() != 1:
            raise AssertionError("The right-opening portrait return did not reveal the previous page")
        if rtl_backward.locator('.reader-turn-sheet').count():
            raise AssertionError("The right-opening portrait return fell back to a sliding page plane")
        if rtl_backward.locator('.reader-turn-portrait-fold').count() != 1:
            raise AssertionError("The right-opening portrait return did not render its paper fold")
        page.wait_for_timeout(500)
        page.screenshot(path="/tmp/shosai-portrait-backward-rtl.png")
        page.wait_for_timeout(850)
        page.locator('.reader-pages[data-visible-pages="1"]').wait_for(timeout=5_000)
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
