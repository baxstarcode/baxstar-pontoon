import sys
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    page = b.new_page()
    page.goto("http://localhost:8813/race_test.html")
    page.wait_for_function("document.title === 'TESTS-DONE'", timeout=180000)
    print(page.inner_text("#results"))
    b.close()
