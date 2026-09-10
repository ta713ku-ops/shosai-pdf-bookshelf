from pathlib import Path
import sys

sys.path.insert(0, "/tmp/shosai-playwright")
from playwright.sync_api import sync_playwright

from verify_app import make_pdf


def main() -> None:
    app_url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4317"
    output = Path("/tmp")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path="/Users/taku/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell",
        )
        context = browser.new_context(viewport={"width": 1180, "height": 820}, device_scale_factor=1, has_touch=True)
        page = context.new_page()
        page.goto(app_url, wait_until="networkidle")
        page.locator('input[type="file"]').set_input_files({
            "name": "reader-preview.pdf",
            "mimeType": "application/pdf",
            "buffer": make_pdf(),
        })
        page.get_by_role("button", name="reader-previewを開く。1/3ページ").wait_for(timeout=20_000)
        page.get_by_role("button", name="reader-previewを開く。1/3ページ").click()
        page.get_by_role("img", name="1ページ").wait_for(timeout=20_000)
        page.get_by_role("img", name="2ページ").wait_for(timeout=20_000)
        page.screenshot(path=output / "shosai-reader-landscape-hidden.png")

        stage = page.locator(".reader-stage")
        stage.click(position={"x": 590, "y": 410})
        page.locator(".reader:not(.reader-ui-hidden)").wait_for()
        page.wait_for_timeout(350)
        page.screenshot(path=output / "shosai-reader-landscape-controls.png")

        page.set_viewport_size({"width": 820, "height": 1180})
        page.wait_for_timeout(500)
        if page.locator(".reader-page").count() != 1:
            raise AssertionError("Portrait reader did not switch to one-page mode")
        page.get_by_role("button", name="操作パネルを隠す").click()
        page.locator(".reader.reader-ui-hidden").wait_for()
        page.wait_for_timeout(350)
        page.screenshot(path=output / "shosai-reader-portrait-hidden.png")
        stage.click(position={"x": 410, "y": 590})
        page.locator(".reader:not(.reader-ui-hidden)").wait_for()
        page.wait_for_timeout(350)
        page.screenshot(path=output / "shosai-reader-portrait-controls.png")
        browser.close()

    print("Captured landscape/portrait reader UI with controls hidden and visible.")


if __name__ == "__main__":
    main()
