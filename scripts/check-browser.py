"""P1 browser regression against a QA fixture server; never uses the collector profile."""

import argparse, json, pathlib, re, tempfile, subprocess
from urllib.parse import quote
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait

parser = argparse.ArgumentParser()
parser.add_argument('--origin', default='http://127.0.0.1:5181')
parser.add_argument('--mode', choices=['local', 'basic', 'session'], default='local')
parser.add_argument('--evidence', default='.winnigo/p1-evidence')
args = parser.parse_args()
if args.mode == 'session':
    subprocess.run(
        ['node', '--env-file=.winnigo/p3-qa.env', 'scripts/reset-auth-qa-limits.mjs'],
        check=True,
        capture_output=True,
    )
from urllib.parse import urlparse

assert urlparse(args.origin).hostname in ['localhost', '127.0.0.1'], 'Loopback QA server required'
evidence = pathlib.Path(args.evidence)
evidence.mkdir(parents=True, exist_ok=True)
values = {}
for line in pathlib.Path('.env.local').read_text().splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        values[key] = value.strip('"')
checks = []
with tempfile.TemporaryDirectory(prefix='winnigo-p0-browser-') as profile:
    options = webdriver.ChromeOptions()
    options.page_load_strategy = 'eager'
    options.set_capability('goog:loggingPrefs', {'browser': 'ALL'})
    for arg in [
        '--headless=new',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1440,1050',
        '--user-data-dir=' + profile,
    ]:
        options.add_argument(arg)
    driver = webdriver.Chrome(options=options)
    wait = WebDriverWait(driver, 30)

    def css(selector):
        return wait.until(lambda browser: browser.find_element(By.CSS_SELECTOR, selector))

    def click_text(text, scope=''):
        element = wait.until(
            lambda browser: next(
                (
                    button
                    for button in browser.find_elements(By.CSS_SELECTOR, scope + 'button')
                    if button.is_displayed() and button.text.strip() == text
                ),
                False,
            )
        )
        driver.execute_script('arguments[0].scrollIntoView({block:"center"})', element)
        element.click()

    def close_dialog():
        driver.find_element(By.TAG_NAME, 'body').send_keys(Keys.ESCAPE)

    def loaded():
        wait.until(
            lambda browser: (
                'Checking sources'
                not in browser.find_element(By.CSS_SELECTOR, '.result-count').text
            )
        )

    try:
        origin = args.origin
        if args.mode == 'basic':
            user = quote(values['WINNIGO_ADMIN_USER'], safe='')
            password = quote(values['WINNIGO_ADMIN_PASSWORD'], safe='')
            driver.get(origin.replace('://', f'://{user}:{password}@'))
        if args.mode == 'session':
            account = json.loads(
                pathlib.Path('.winnigo/p3-evidence/browser-account.json').read_text()
            )
            driver.get(origin + '/login')
            css('input[name="email"]').send_keys(account['ownerEmail'])
            css('input[name="password"]').send_keys(account['password'])
            css('button[type="submit"]').click()
            wait.until(lambda browser: urlparse(browser.current_url).path == '/')
        driver.get(origin)
        loaded()
        assert (
            driver.execute_script(
                "return getComputedStyle(document.querySelector('.cards')).display"
            )
            == 'grid'
        )
        assert (
            driver.execute_script(
                "return getComputedStyle(document.querySelector('.topbar')).display"
            )
            == 'flex'
        )
        driver.save_screenshot(str(evidence / 'discovery.png'))
        checks.append('Next CSS grid/topbar and completed client loading')
        assert len(driver.find_elements(By.CSS_SELECTOR, '.listing-card')) == 24
        click_text('Show more discoveries')
        wait.until(
            lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.listing-card')) == 48
        )
        checks.append('Bounded first page and server-backed load-more pagination')
        click_text('Community Highlights', '.collection-filters ')
        wait.until(
            lambda browser: (
                'P0 Betula Lake outing' in browser.find_element(By.CSS_SELECTOR, '.cards').text
            )
        )
        assert 'P0 hidden fixture' not in css('.cards').text
        assert 'P0 owner correction' in css('.cards').text
        search = css('input[aria-label="Search events, places, or activities"]')
        search.send_keys('P0 Betula')
        wait.until(lambda browser: '1 discovery' in css('.result-count').text)
        css('.card-title').click()
        assert 'general area' in css('.detail-dialog').get_attribute('textContent')
        assert 'parking details are unconfirmed' in css('.comment-notes').get_attribute(
            'textContent'
        )
        assert 'comment_id=' in css('.comment-notes a').get_attribute('href')
        css('.gallery-cover').click()
        wait.until(
            lambda browser: browser.execute_script(
                "return [...document.querySelectorAll('.full-photo img')].every(i=>i.complete && i.naturalWidth>0)"
            )
        )
        css('.gallery-next').click()
        wait.until(lambda browser: '2 / 2' in css('.gallery-footer').text)
        css('.gallery-prev').click()
        wait.until(lambda browser: '1 / 2' in css('.gallery-footer').text)
        driver.save_screenshot(str(evidence / 'gallery.png'))
        close_dialog()
        wait.until(
            lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.photo-viewer')) == 0
        )
        close_dialog()
        wait.until(
            lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.detail-dialog')) == 0
        )
        checks.append(
            'Community/search filters, hidden/override preservation, approximate warning, comments, full photos and navigation'
        )
        click_text('Trail map', 'nav ')
        click_text('Community Highlights', '.collection-filters ')
        wait.until(
            lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.map-list-item')) == 2
        )
        marker = wait.until(
            lambda browser: next(
                (
                    pin
                    for pin in browser.find_elements(By.CSS_SELECTOR, '.trail-pin.approximate')
                    if '2 outings' in (pin.get_attribute('title') or '')
                ),
                False,
            )
        )
        marker.click()
        # Both visible fixture posts share the lake point; marker opens their picker.
        css('.map-group-popup button').click()
        assert 'general area' in css('.detail-dialog').get_attribute('textContent')
        close_dialog()
        wait.until(
            lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.detail-dialog')) == 0
        )
        driver.save_screenshot(str(evidence / 'map.png'))
        checks.append(
            'Interactive Leaflet map, grouped approximate lake marker and detail selection'
        )
        # Regression for the P0 Leaflet zoom/unmount failure. Exercise both filters and navigation.
        for _ in range(5):
            css('.leaflet-control-zoom-in').click()
            click_text('Explore', 'nav ')
            click_text('Trail map', 'nav ')
            css('.leaflet-container')
            click_text('Community Highlights', '.collection-filters ')
            css('.trail-pin.approximate')
        click_text('Explore', 'nav ')
        click_text('Official Trails', '.collection-filters ')
        checks.append('Repeated map zoom/filter/unmount transitions without JavaScript exceptions')
        wait.until(
            lambda browser: (
                len(
                    browser.find_elements(
                        By.CSS_SELECTOR, '.listing-card .collection-label.official'
                    )
                )
                > 0
            )
        )
        css('.card-title').click()
        assert 'Summer map' in css('.official-details').get_attribute('textContent')
        assert 'Winter map' in css('.official-details').get_attribute('textContent')
        close_dialog()
        wait.until(
            lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.detail-dialog')) == 0
        )
        click_text('Meet the sources')
        assert 'Trails Manitoba' in css('[role="dialog"]').get_attribute('textContent')
        close_dialog()
        checks.append('Official trail seasonal details and source dialog')
        driver.get(origin + '/admin')
        wait.until(
            lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.admin-sources > div')) > 0
        )
        css('input[aria-label="Search collection"]').send_keys('P0 Betula')
        wait.until(
            lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '.admin-list > div')) == 1
        )
        click_text('Edit', '.admin-list ')
        title = css('#edit-title')
        title.send_keys(Keys.CONTROL + 'a')
        title.send_keys('P0 browser correction')
        click_text('Save corrections')
        wait.until(lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '#edit-title')) == 0)
        search = css('input[aria-label="Search collection"]')
        search.send_keys(Keys.CONTROL + 'a')
        search.send_keys('P0 browser correction')
        css('button[aria-label="Hide P0 browser correction"]').click()
        css('button[aria-label="Show P0 browser correction"]').click()
        css('button[aria-label="Hide P0 browser correction"]')
        assert len(driver.find_elements(By.CSS_SELECTOR, '.admin-sources > div')) > 0
        # Restore the synthetic title for a repeatable run.
        click_text('Edit', '.admin-list ')
        title = css('#edit-title')
        title.send_keys(Keys.CONTROL + 'a')
        title.send_keys('P0 Betula Lake outing')
        click_text('Save corrections')
        wait.until(lambda browser: len(browser.find_elements(By.CSS_SELECTOR, '#edit-title')) == 0)
        checks.append('Admin source status, edit persistence and hide/show')
        errors = [
            entry
            for entry in driver.get_log('browser')
            if entry.get('source') == 'javascript' and entry['level'] == 'SEVERE'
        ]
        assert not errors, errors
        report = {
            'status': 'passed',
            'browser': driver.capabilities['browserVersion'],
            'origin': origin,
            'mode': args.mode,
            'checks': checks,
        }
        (evidence / 'browser.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
    except Exception:
        driver.save_screenshot(str(evidence / 'failure.png'))
        raise
    finally:
        driver.quit()
