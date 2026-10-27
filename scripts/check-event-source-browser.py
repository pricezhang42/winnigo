"""Read-only real-browser verification of a collected source on loopback QA servers."""

import argparse
import json
import pathlib
import tempfile
from urllib.parse import quote, urlparse
from selenium import webdriver
from selenium.common.exceptions import StaleElementReferenceException
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

p = argparse.ArgumentParser()
p.add_argument('--origins', nargs='+', required=True)
p.add_argument('--source', required=True)
p.add_argument('--query', required=True)
p.add_argument('--evidence', required=True)
p.add_argument('--env', default='.winnigo/p2-qa.env')
p.add_argument('--single-event', action='store_true')
p.add_argument('--image-caption')
a = p.parse_args()
values = {}
for filename in ['.env.local', a.env]:
    for line in pathlib.Path(filename).read_text().splitlines():
        if '=' in line:
            key, value = line.split('=', 1)
            values[key] = value.strip('"')
evidence = pathlib.Path(a.evidence)
evidence.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='winnigo-source-browser-') as profile:
    options = webdriver.ChromeOptions()
    for arg in ['--headless=new', '--window-size=1440,1050', '--user-data-dir=' + profile]:
        options.add_argument(arg)
    options.set_capability('goog:loggingPrefs', {'browser': 'ALL'})
    driver = webdriver.Chrome(options=options)
    wait = WebDriverWait(driver, 45, ignored_exceptions=(StaleElementReferenceException,))
    try:
        for origin in a.origins:
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
            wait.until(
                lambda d: d.execute_script(
                    "return Object.keys(arguments[0]).some(k=>k.startsWith('__reactProps$'))",
                    search,
                )
            )
            search.send_keys(a.query)
            wait.until(
                lambda d: any(
                    a.query.lower() in c.text.lower()
                    for c in d.find_elements(By.CSS_SELECTOR, '.listing-card')
                )
            )
            wait.until(
                lambda d: (
                    'Checking sources' not in d.find_element(By.CSS_SELECTOR, '.result-count').text
                )
            )
            result = driver.execute_async_script(
                "const done=arguments[arguments.length-1];fetch('/api/listings?query='+encodeURIComponent(arguments[0])+'&limit=100').then(r=>r.json()).then(done)",
                a.query,
            )
            items = [e for e in result['items'] if e['source'] == a.source]
            assert items and all(e.get('start') for e in items), result
            assert len({e['id'] for e in items}) == len(items)
            if a.single_event:
                assert len(items) == 1 and not items[0].get('recurring'), items
            else:
                assert any(e.get('recurring') for e in items)
            if a.image_caption:
                assert all(e.get('imageCaption') == a.image_caption for e in items)
            assert all(len(e.get('images', [])) <= 3 for e in items)
            card = wait.until(
                lambda d: next(
                    (
                        c
                        for c in d.find_elements(By.CSS_SELECTOR, '.listing-card')
                        if c.find_elements(By.CSS_SELECTOR, 'img')
                    ),
                    False,
                )
            )
            assert (
                driver.execute_script(
                    'return getComputedStyle(arguments[0].parentElement).display', card
                )
                == 'grid'
            )
            wait.until(
                lambda d: d.execute_script(
                    'return arguments[0].complete&&arguments[0].naturalWidth>0',
                    card.find_element(By.CSS_SELECTOR, 'img'),
                )
            )
            assert any(e.get('image', '').startswith('/api/photos/') for e in items)
            driver.save_screenshot(str(evidence / f'cards-{parsed.port}.png'))
            card.find_element(By.CSS_SELECTOR, '.card-title').click()
            wait.until(lambda d: d.find_element(By.CSS_SELECTOR, '.detail-dialog'))
            if a.image_caption:
                assert (
                    a.image_caption in driver.find_element(By.CSS_SELECTOR, '.detail-dialog').text
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
            driver.save_screenshot(str(evidence / f'detail-{parsed.port}.png'))
            assert (
                'Listings could not be loaded' not in driver.find_element(By.TAG_NAME, 'body').text
            )
            errors = [
                e
                for e in driver.get_log('browser')
                if e.get('source') == 'javascript' and e['level'] == 'SEVERE'
            ]
            assert not errors, errors
            print(
                json.dumps(
                    {
                        'origin': origin,
                        'source': a.source,
                        'datedCards': len(items),
                        'recurring': any(e.get('recurring') for e in items),
                        'imageCaption': a.image_caption,
                        'privatePhotosLoaded': True,
                        'grid': True,
                        'javascriptErrors': len(errors),
                    }
                )
            )
    finally:
        driver.quit()
