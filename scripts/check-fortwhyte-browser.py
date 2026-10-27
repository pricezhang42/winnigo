"""Read-only FortWhyte card, recurring-date and private-photo checks on loopback QA apps."""

import argparse
import json
import pathlib
import tempfile
from urllib.parse import quote, urlparse

from selenium import webdriver
from selenium.common.exceptions import StaleElementReferenceException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait

parser = argparse.ArgumentParser()
parser.add_argument(
    '--origins', nargs='+', default=['http://127.0.0.1:5182', 'http://127.0.0.1:5184']
)
parser.add_argument('--env', default='.winnigo/p2-qa.env')
parser.add_argument('--evidence', default='.winnigo/fortwhyte-evidence')
args = parser.parse_args()
values = {}
for filename in ['.env.local', args.env]:
    for line in pathlib.Path(filename).read_text().splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            values[k] = v.strip('"')
evidence = pathlib.Path(args.evidence)
evidence.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='winnigo-fortwhyte-browser-') as profile:
    options = webdriver.ChromeOptions()
    for arg in ['--headless=new', '--window-size=1440,1050', '--user-data-dir=' + profile]:
        options.add_argument(arg)
    options.set_capability('goog:loggingPrefs', {'browser': 'ALL'})
    driver = webdriver.Chrome(options=options)
    wait = WebDriverWait(driver, 40, ignored_exceptions=(StaleElementReferenceException,))
    try:
        for origin in args.origins:
            parsed = urlparse(origin)
            assert parsed.hostname in ['127.0.0.1', 'localhost']
            login = origin.replace(
                '://',
                f'://{quote(values["WINNIGO_ADMIN_USER"], safe="")}:{quote(values["WINNIGO_ADMIN_PASSWORD"], safe="")}@',
            )
            driver.get(login)
            driver.get(origin)
            search = wait.until(
                lambda d: d.find_element(
                    By.CSS_SELECTOR, 'input[aria-label="Search events, places, or activities"]'
                )
            )
            # Server-rendered input appears before React attaches its change handler.
            wait.until(
                lambda d: d.execute_script(
                    "return Object.keys(arguments[0]).some(k=>k.startsWith('__reactProps$'))",
                    search,
                )
            )
            search.send_keys('FortWhyte')
            wait.until(
                lambda d: any(
                    'Via FortWhyte Alive' in c.text
                    for c in d.find_elements(By.CSS_SELECTOR, '.listing-card')
                )
            )
            wait.until(
                lambda d: (
                    'Checking sources' not in d.find_element(By.CSS_SELECTOR, '.result-count').text
                )
            )
            assert (
                driver.execute_script(
                    "return getComputedStyle(document.querySelector('.listing-card').parentElement).display"
                )
                == 'grid'
            )
            result = driver.execute_async_script(
                "const done=arguments[0];fetch('/api/listings?query=FortWhyte&limit=100').then(r=>r.json()).then(done)"
            )
            items = [e for e in result['items'] if e['source'] == 'fortwhyte']
            assert items and any(e['recurring'] for e in items)
            assert all(e['start'] and e['time'] for e in items)
            photos = [e for e in items if e.get('image')]
            assert photos and all(
                e['image'].startswith('/api/photos/') and len(e['images']) <= 3 for e in photos
            )
            # Search a photographed event so a real stored image is visible in both card and details.
            search.send_keys(Keys.COMMAND + 'a')
            search.send_keys(Keys.BACKSPACE)
            search.send_keys(photos[0]['title'])
            wait.until(
                lambda d: any(
                    'Via FortWhyte Alive' in c.text and c.find_elements(By.CSS_SELECTOR, 'img')
                    for c in d.find_elements(By.CSS_SELECTOR, '.listing-card')
                )
            )
            card = next(
                c
                for c in driver.find_elements(By.CSS_SELECTOR, '.listing-card')
                if 'Via FortWhyte Alive' in c.text and c.find_elements(By.CSS_SELECTOR, 'img')
            )
            wait.until(
                lambda d: d.execute_script(
                    'return arguments[0].complete && arguments[0].naturalWidth > 0',
                    card.find_element(By.CSS_SELECTOR, 'img'),
                )
            )
            assert 'a.m.' in card.text or 'p.m.' in card.text
            card.find_element(By.CSS_SELECTOR, '.card-title').click()
            wait.until(
                lambda d: 'FortWhyte' in d.find_element(By.CSS_SELECTOR, '.detail-dialog').text
            )
            wait.until(
                lambda d: d.execute_script(
                    'return [...document.querySelectorAll(".detail-dialog img")].some(i=>i.complete&&i.naturalWidth>0)'
                )
            )
            wait.until(
                lambda d: d.execute_script(
                    'return document.querySelector(".detail-dialog").getAnimations({subtree:true}).every(a=>a.playState!=="running")'
                )
            )
            driver.save_screenshot(str(evidence / f'fortwhyte-{parsed.port}.png'))
            assert (
                'Listings could not be loaded' not in driver.find_element(By.TAG_NAME, 'body').text
            )
            for term, slug in [
                ('Bison Bus Tour', 'bison-bus-tour'),
                ('Bison Walk for World Bison Day', 'world-bison-day'),
            ]:
                driver.find_element(By.TAG_NAME, 'body').send_keys(Keys.ESCAPE)
                bison = driver.execute_async_script(
                    'const done=arguments[arguments.length-1];fetch(arguments[0]).then(r=>r.json()).then(done)',
                    '/api/listings?query=' + quote(term) + '&limit=100',
                )
                bison = [e for e in bison['items'] if e['source'] == 'fortwhyte']
                assert bison and all(e.get('image', '').startswith('/api/photos/') for e in bison)
                target = next((e for e in bison if e['start'] == '2026-10-31'), bison[0])
                search = driver.find_element(
                    By.CSS_SELECTOR, 'input[aria-label="Search events, places, or activities"]'
                )
                search.send_keys(Keys.COMMAND + 'a')
                search.send_keys(Keys.BACKSPACE)
                search.send_keys(term)
                visit = driver.find_element(By.CSS_SELECTOR, 'input[aria-label="Visit date"]')
                driver.execute_script(
                    "const e=arguments[0];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,arguments[1]);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));",
                    visit,
                    target['start'],
                )
                wait.until(
                    lambda d: any(
                        term in c.text and 'Via FortWhyte Alive' in c.text
                        for c in d.find_elements(By.CSS_SELECTOR, '.listing-card')
                    )
                )
                card = next(
                    c
                    for c in driver.find_elements(By.CSS_SELECTOR, '.listing-card')
                    if term in c.text and 'Via FortWhyte Alive' in c.text
                )
                wait.until(
                    lambda d: d.execute_script(
                        'return arguments[0].complete && arguments[0].naturalWidth > 0',
                        card.find_element(By.CSS_SELECTOR, 'img'),
                    )
                )
                card.find_element(By.CSS_SELECTOR, '.card-title').click()
                wait.until(lambda d: term in d.find_element(By.CSS_SELECTOR, '.detail-dialog').text)
                wait.until(
                    lambda d: d.execute_script(
                        'return [...document.querySelectorAll(".detail-dialog img")].some(i=>i.complete&&i.naturalWidth>0)'
                    )
                )
                wait.until(
                    lambda d: d.execute_script(
                        'return document.querySelector(".detail-dialog").getAnimations({subtree:true}).every(a=>a.playState!=="running")'
                    )
                )
                driver.save_screenshot(str(evidence / f'{slug}-{parsed.port}.png'))
            errors = [e for e in driver.get_log('browser') if e['level'] == 'SEVERE']
            assert not errors, errors
            print(
                json.dumps(
                    {
                        'origin': origin,
                        'fortwhyteCards': len(items),
                        'grid': True,
                        'datedRecurringCards': True,
                        'privatePhotosLoaded': True,
                        'worldBisonDayPhotoLoaded': True,
                        'consoleErrors': 0,
                    }
                )
            )
    except Exception:
        driver.save_screenshot(str(evidence / 'failure.png'))
        raise
    finally:
        driver.quit()
