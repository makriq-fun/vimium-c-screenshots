#!/usr/bin/env python3
"""Real Firefox end-to-end test for Vimium C Screenshots.

Run from the repository root after `npm run mv2-ff`:

    FIREFOX_BIN=/path/to/firefox EXT_XPI=vimium_c-*-firefox-*.zip \
      xvfb-run -a python3 tests/firefox/test_firefox.py

The extension is installed as a temporary add-on through Marionette (Selenium), the browser is
driven with real key events, and the resulting PNG is read back from the X11 clipboard with xclip.
"""
import glob
import io
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image
from selenium import webdriver
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Firefox screenshot test</title>
<style>
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font: 16px/1.4 sans-serif; }
  #fixed { position: fixed; top: 0; left: 0; width: 100%; height: 40px; background: rgb(220, 0, 0); z-index: 50; }
  #before { height: 250px; background: rgb(245, 245, 245); }
  #elem { width: 500px; height: 1400px; margin-left: 60px; background: rgb(0, 128, 255);
    border: 4px solid rgb(0, 0, 0); box-sizing: border-box; position: relative; }
  #elemTop { height: 30px; background: rgb(250, 220, 0); }
  #elemBottom { position: absolute; left: 0; right: 0; bottom: 0; height: 30px; background: rgb(0, 200, 120); }
  #wide { width: 2200px; height: 120px; background: linear-gradient(to right, rgb(0, 200, 0), rgb(200, 0, 200)); }
  #footer { width: 2200px; height: 500px; background: rgb(0, 180, 90); }
</style></head>
<body>
  <div id="fixed"></div>
  <div id="before"><p>Text before the target.</p></div>
  <article id="elem" aria-label="target">
    <div id="elemTop"></div>
    <p style="padding: 20px">A tall element larger than the viewport.</p>
    <div id="elemBottom"></div>
  </article>
  <div id="wide"></div>
  <div id="footer"></div>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/"):
            body = PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def log_message(self, *args):
        pass


def clipboard_png():
    try:
        proc = subprocess.run(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    data = proc.stdout
    return data if proc.returncode == 0 and data[:8] == b"\x89PNG\r\n\x1a\n" else None


def clipboard_clear():
    try:
        subprocess.run(["xclip", "-selection", "clipboard", "-i"], input=b" ",
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        pass


def wait_clipboard(previous=None, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        data = clipboard_png()
        if data and (previous is None or data != previous):
            return data
        time.sleep(0.1)
    raise AssertionError("no image/png in the clipboard")


def press(driver, keys, gap=0.07):
    for key in keys:
        ActionChains(driver).send_keys(key).perform()
        time.sleep(gap)


def ui(driver):
    return driver.execute_script("""
      const host = document.getElementById('vimium-c-screenshot-ui');
      const root = host && host.shadowRoot;
      return {
        present: !!host,
        markers: root ? Array.from(root.querySelectorAll('.marker')).map((el) => ({
          label: el.getAttribute('data-vcs-label') || '',
          rect: (el.getAttribute('data-vcs-rect') || '').split(',').map(Number),
        })) : [],
        selected: !!(root && root.querySelector('.hl')),
      };
    """)


def wait_ui(driver, kind):
    deadline = time.time() + 10
    while time.time() < deadline:
        state = ui(driver)
        if kind == "gone" and not state["present"]:
            return
        if kind == "markers" and state["markers"]:
            return
        if kind == "selected" and state["selected"]:
            return
        time.sleep(0.05)
    raise AssertionError("UI did not reach state " + kind)


def clear_state(driver):
    driver.execute_script("document.documentElement.removeAttribute('data-vcs-state')")


def wait_state(driver, timeout=40):
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = driver.execute_script("return document.documentElement.getAttribute('data-vcs-state')")
        if state and state != "capturing:element" and not state.startswith("capturing:"):
            return state
        time.sleep(0.1)
    raise AssertionError("the extension did not finish the capture")


def image_size(data):
    image = Image.open(io.BytesIO(data))
    if image.mode != "RGBA":
        image = image.convert("RGBA")
    size = image.size
    print("   image:", size, image.mode, image.getpixel((20, 14)), image.getpixel((size[0] // 2, size[1] // 2)))
    os.makedirs(os.path.join("tests", "firefox", "out"), exist_ok=True)
    path = os.path.join("tests", "firefox", "out", "last.png")
    with open(path, "wb") as f:
        f.write(data)
    flat = Image.alpha_composite(Image.new("RGBA", size, (255, 255, 255, 255)), image).convert("RGB")
    return size, flat


def near(actual, expected, tolerance, label):
    if abs(actual - expected) > tolerance:
        raise AssertionError("%s: expected %s +/- %s, got %s" % (label, expected, tolerance, actual))


def color_near(pixel, expected, tolerance, label):
    for i in range(3):
        if abs(pixel[i] - expected[i]) > tolerance:
            raise AssertionError("%s: expected rgb%s, got rgb%s" % (label, expected, pixel[:3]))


def red_rows(image):
    width, height = image.size
    rows = []
    for y in range(0, min(height, 240), max(1, height // 400)):
        red = 0
        for x in range(0, min(width, 600), max(1, width // 120)):
            r, g, b = image.getpixel((x, y))[:3]
            if r > 180 and g < 90 and b < 90:
                red += 1
        if red > 20:
            rows.append(y)
    return rows


def element_rect(driver):
    return driver.execute_script("""
      const r = document.getElementById('elem').getBoundingClientRect();
      return [r.left + window.scrollX, r.top + window.scrollY, r.width, r.height,
              Math.max(document.documentElement.scrollWidth, document.documentElement.clientWidth),
              Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight),
              window.innerWidth, window.innerHeight];
    """)


def test_element(driver):
    driver.execute_script("window.scrollTo(0, 0)")
    clipboard_clear()
    clear_state(driver)
    press(driver, "ss")
    wait_ui(driver, "markers")
    rect = element_rect(driver)
    markers = ui(driver)["markers"]
    target = None
    for marker in markers:
        r = marker["rect"]
        if (len(r) == 4 and abs(r[0] - rect[0]) <= 2 and abs(r[1] - rect[1]) <= 2
                and abs(r[2] - rect[2]) <= 2 and abs(r[3] - rect[3]) <= 2):
            target = marker
            break
    assert target, "the target element has a hint label"
    press(driver, target["label"])
    wait_ui(driver, "selected")
    press(driver, "s")
    state = wait_state(driver)
    assert state.startswith("ok:"), state
    data = wait_clipboard()
    (width, height), image = image_size(data)
    near(width, rect[2], 3, "element width")
    near(height, rect[3], 3, "element height")
    color_near(image.getpixel((20, 14)), (250, 220, 0), 35, "element top band")
    color_near(image.getpixel((width - 24, height // 2)), (0, 128, 255), 35, "element middle")
    color_near(image.getpixel((width // 2, height - 16)), (0, 200, 120), 35, "element bottom band")
    wait_ui(driver, "gone")
    print("   element:", width, "x", height)
    return data


def test_viewport(driver):
    driver.execute_script("window.scrollTo(0, 0)")
    clipboard_clear()
    clear_state(driver)
    press(driver, "sv")
    state = wait_state(driver)
    assert state.startswith("ok:"), state
    data = wait_clipboard()
    (width, height), image = image_size(data)
    rect = element_rect(driver)
    near(width, rect[6], 40, "viewport width")
    near(height, rect[7], 40, "viewport height")
    print("   viewport:", width, "x", height)
    return data


def test_full_page(driver):
    driver.execute_script("window.scrollTo(0, 0)")
    clipboard_clear()
    clear_state(driver)
    press(driver, "sa")
    state = wait_state(driver)
    assert state.startswith("ok:"), state
    data = wait_clipboard()
    (width, height), image = image_size(data)
    rect = element_rect(driver)
    near(width, rect[4], 5, "full page width")
    near(height, rect[5], 5, "full page height")
    color_near(image.getpixel((100, height - 16)), (0, 180, 90), 35, "full page footer")
    color_near(image.getpixel((width - 30, height - 16)), (0, 180, 90), 35, "full page right footer")
    rows = red_rows(image)
    assert rows, "the fixed header is captured at the top"
    assert max(rows) < 65, "the fixed header is not repeated down the page"
    print("   full page:", width, "x", height)
    return data


def test_escape(driver):
    driver.execute_script("window.scrollTo(0, 0)")
    clipboard_clear()
    press(driver, "ss")
    wait_ui(driver, "markers")
    press(driver, "Escape")
    wait_ui(driver, "gone")
    time.sleep(0.5)
    assert clipboard_png() is None, "Esc during labels must not copy anything"

    press(driver, "ss")
    wait_ui(driver, "markers")
    markers = ui(driver)["markers"]
    assert len(markers) > 2
    press(driver, markers[1]["label"])
    wait_ui(driver, "selected")
    press(driver, "Escape")
    wait_ui(driver, "gone")
    time.sleep(0.5)
    assert clipboard_png() is None, "Esc after selecting must not copy anything"


def test_normal_mode(driver):
    driver.execute_script("window.scrollTo(0, 0)")
    press(driver, "s")
    time.sleep(0.1)
    press(driver, "Escape")
    press(driver, "j")
    time.sleep(0.4)
    assert driver.execute_script("return window.scrollY") > 0, "j still scrolls"
    press(driver, "gg")
    time.sleep(0.4)
    assert driver.execute_script("return window.scrollY") == 0, "gg still scrolls to top"


def main():
    xpi = os.environ.get("EXT_XPI") or (glob.glob("vimium_c-*-firefox-*.zip") + [""])[0]
    if not xpi or not os.path.exists(xpi):
        raise SystemExit("extension XPI not found; run npm run mv2-ff first")
    firefox = os.environ.get("FIREFOX_BIN")
    if not firefox or not os.path.exists(firefox):
        raise SystemExit("FIREFOX_BIN is not set to a Firefox executable")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = "http://127.0.0.1:%d/?vcs-test=1" % server.server_address[1]

    options = webdriver.FirefoxOptions()
    options.binary_location = firefox
    options.set_preference("xpinstall.signatures.required", False)
    options.set_preference("extensions.autoDisableScopes", 0)
    options.set_preference("browser.shell.checkDefaultBrowser", False)
    options.set_preference("browser.startup.page", 0)
    options.set_preference("dom.disable_open_during_load", False)

    driver = webdriver.Firefox(options=options)
    try:
        driver.set_window_size(1280, 1000)
        driver.set_window_position(0, 0)
        try:
            driver.fullscreen_window()
        except Exception:
            pass
        addon = driver.install_addon(os.path.abspath(xpi), temporary=True)
        print("installed", addon)
        print("windows before page:", driver.window_handles, "current:", driver.current_window_handle)
        driver.switch_to.new_window("tab")
        driver.get(origin)
        print("windows after page:", driver.window_handles, "current:", driver.current_window_handle,
              "size:", driver.get_window_size())
        WebDriverWait(driver, 20).until(
            lambda d: d.execute_script("return document.readyState") == "complete")
        driver.find_element(By.TAG_NAME, "body").click()
        time.sleep(0.5)
        os.makedirs(os.path.join("tests", "firefox", "out"), exist_ok=True)
        driver.save_screenshot(os.path.join("tests", "firefox", "out", "page.png"))
        print("   page screenshot saved")

        print("1. viewport screenshot")
        test_viewport(driver)
        print("2. element screenshot")
        test_element(driver)
        print("3. full page screenshot")
        test_full_page(driver)
        print("4. Esc cancellation")
        test_escape(driver)
        print("5. normal Vimium keys")
        test_normal_mode(driver)
    finally:
        driver.quit()
        server.shutdown()
    print("all Firefox screenshot checks passed")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("FAILED:", exc, file=sys.stderr)
        raise
