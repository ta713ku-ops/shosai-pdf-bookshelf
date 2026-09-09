from pathlib import Path
import sys

sys.path.insert(0, "/tmp/shosai-playwright")
from playwright.sync_api import sync_playwright


def make_pdf() -> bytes:
    stream = b"BT /F1 28 Tf 72 700 Td (Shosai Test Book) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream),
    ]
    data = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f"{index} 0 obj\n".encode())
        data.extend(obj)
        data.extend(b"\nendobj\n")
    xref = len(data)
    data.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    data.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        data.extend(f"{offset:010d} 00000 n \n".encode())
    data.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(data)


def main() -> None:
    errors: list[str] = []
    output = Path("/tmp")
    app_url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4317"
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
        page.wait_for_timeout(1000)
        if not page.get_by_role("heading", name="すべての本").count():
            page.screenshot(path=output / "shosai-load-failure.png", full_page=True)
            raise AssertionError(f"App did not render. title={page.title()!r} body={page.locator('body').inner_text()!r} errors={errors!r}")
        page.get_by_role("heading", name="すべての本").wait_for()
        page.evaluate("navigator.serviceWorker.ready")
        page.get_by_text("ここに最初の一冊を").wait_for()
        page.screenshot(path=output / "shosai-empty-landscape.png", full_page=True)

        page.get_by_role("button", name="＋ 本棚を追加").click()
        page.get_by_label("本棚の名前").fill("雑誌")
        page.get_by_role("button", name="追加", exact=True).click()
        page.get_by_role("button", name="雑誌を削除").wait_for()

        page.locator('input[type="file"]').set_input_files({
            "name": "friend-plan.pdf",
            "mimeType": "application/pdf",
            "buffer": make_pdf(),
        })
        page.get_by_role("button", name="friend-planを開く。1/1ページ").wait_for(timeout=15_000)
        page.locator('input[type="file"]').set_input_files([
            {"name": "second.pdf", "mimeType": "application/pdf", "buffer": make_pdf()},
            {"name": "broken.pdf", "mimeType": "application/pdf", "buffer": b"not a pdf"},
        ])
        page.get_by_text("追加 1冊・除外 0件・失敗 1件。除外は重複またはPDF以外です。").wait_for(timeout=15_000)
        page.get_by_role("button", name="secondを開く。1/1ページ").wait_for(timeout=15_000)
        page.screenshot(path=output / "shosai-library-landscape.png", full_page=True)
        page.get_by_role("button", name="friend-planを開く。1/1ページ").click()
        page.wait_for_function("document.fullscreenElement !== null", timeout=5_000)
        page.get_by_role("region", name="friend-planを読む").wait_for(timeout=15_000)
        page.get_by_role("button", name="全画面を解除").wait_for()
        page.get_by_role("img", name="1ページ").wait_for(timeout=15_000)
        page.screenshot(path=output / "shosai-reader-landscape.png")
        page.get_by_role("button", name="本棚に戻る").click()
        page.wait_for_function("document.fullscreenElement === null", timeout=5_000)

        page.reload(wait_until="networkidle")
        page.get_by_role("button", name="friend-planを開く。1/1ページ").wait_for(timeout=10_000)
        page.set_viewport_size({"width": 820, "height": 1180})
        page.wait_for_timeout(300)
        shelf_delete = page.get_by_role("button", name="雑誌を削除")
        shelf_delete.wait_for()
        shelf_delete_style = shelf_delete.evaluate("element => ({ display: getComputedStyle(element).display, opacity: Number(getComputedStyle(element).opacity) })")
        if shelf_delete_style["display"] == "none" or shelf_delete_style["opacity"] < 0.5:
            raise AssertionError(f"Shelf delete control is not visible for touch portrait: {shelf_delete_style!r}")
        page.screenshot(path=output / "shosai-library-portrait.png", full_page=True)
        context.set_offline(True)
        page.reload(wait_until="domcontentloaded")
        page.get_by_role("heading", name="すべての本").wait_for(timeout=10_000)
        page.get_by_role("button", name="friend-planを開く。1/1ページ").click()
        page.wait_for_timeout(2000)
        if not page.get_by_role("img", name="1ページ").count():
            page.screenshot(path=output / "shosai-reader-offline-failure.png", full_page=True)
            raise AssertionError(f"Offline reader did not render. body={page.locator('body').inner_text()!r} errors={errors!r}")
        page.get_by_role("img", name="1ページ").wait_for(timeout=15_000)
        page.screenshot(path=output / "shosai-reader-offline.png")
        context.set_offline(False)
        browser.close()

    if errors:
        raise AssertionError("\n".join(errors))
    print("Verified partial import recovery, shelf controls, cover generation, fullscreen reader entry/exit, persistence, offline reading, and landscape/portrait layouts.")


if __name__ == "__main__":
    main()
