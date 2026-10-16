"""Verify event occurrence/date discovery on loopback QA servers with Selenium."""

import argparse
import json
import pathlib
import tempfile
from urllib.parse import quote, urlparse

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait

parser = argparse.ArgumentParser()
parser.add_argument('--origins', nargs='+', default=['http://127.0.0.1:5182'])
parser.add_argument('--env', default='.winnigo/events-qa.env')
parser.add_argument('--evidence', default='.winnigo/event-evidence')
args = parser.parse_args()
values = {}
for filename in ['.env.local', args.env]:
    for line in pathlib.Path(filename).read_text().splitlines():
        if '=' in line:
            key, value = line.split('=', 1)
            values[key] = value.strip('"')
evidence = pathlib.Path(args.evidence)
evidence.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='winnigo-event-browser-') as profile:
    options = webdriver.ChromeOptions()
    options.set_capability('goog:loggingPrefs', {'browser': 'ALL'})
    for arg in ['--headless=new', '--window-size=1440,1050', '--user-data-dir=' + profile]:
        options.add_argument(arg)
    driver = webdriver.Chrome(options=options)
    wait = WebDriverWait(driver, 40)

    def api(path):
        return driver.execute_async_script(
            'const done=arguments[arguments.length-1];fetch(arguments[0]).then(async r=>done({status:r.status,body:await r.json()})).catch(e=>done({error:String(e)}))',
            path,
        )

    def screenshot_ready(path):
        wait.until(
            lambda d: d.execute_script(
                'return document.querySelector(".detail-dialog").getAnimations({subtree:true}).every(a=>a.playState!=="running")'
            )
        )
        driver.save_screenshot(str(path))

    def search_for(text):
        element = wait.until(
            lambda d: d.find_element(
                By.CSS_SELECTOR, 'input[aria-label="Search events, places, or activities"]'
            )
        )
        driver.execute_script('arguments[0].value=""', element)
        element.send_keys(Keys.COMMAND + 'a')
        element.send_keys(Keys.BACKSPACE)
        element.send_keys(text)
        wait.until(
            lambda d: (
                'Checking sources' not in d.find_element(By.CSS_SELECTOR, '.result-count').text
            )
        )

    def visit_date(day):
        element = driver.find_element(By.CSS_SELECTOR, 'input[aria-label="Visit date"]')
        driver.execute_script(
            'const e=arguments[0];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,arguments[1]);e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));',
            element,
            day,
        )
        assert element.get_attribute('value') == day

    try:
        for origin in args.origins:
            parsed = urlparse(origin)
            assert parsed.hostname in ['localhost', '127.0.0.1'], 'Loopback QA only'
            driver.get(
                origin.replace(
                    '://',
                    f'://{quote(values["WINNIGO_ADMIN_USER"], safe="")}:{quote(values["WINNIGO_ADMIN_PASSWORD"], safe="")}@',
                )
            )
            driver.get(origin)
            search_for('QA Visiting Calendar')
            wait.until(
                lambda d: (
                    len(d.find_elements(By.CSS_SELECTOR, '.listing-card')) == 1
                    and 'QA Visiting Calendar'
                    in d.find_element(By.CSS_SELECTOR, '.listing-card').text
                )
            )
            assert (
                driver.execute_script(
                    'return getComputedStyle(document.querySelector(".cards")).display'
                )
                == 'grid'
            )
            for day, status in [
                ('2026-10-26', 'unavailable'),
                ('2026-10-19', 'available'),
                ('2026-11-11', 'unavailable'),
                ('2026-12-01', 'unknown'),
            ]:
                result = api('/api/listings/qa-event-availability/availability?date=' + day)
                assert result['status'] == 200 and result['body']['status'] == status, result
                visit_date(day)
                expected = 1 if status == 'available' else 0
                wait.until(
                    lambda d: (
                        len(d.find_elements(By.CSS_SELECTOR, '.listing-card')) == expected
                        and 'Checking sources'
                        not in d.find_element(By.CSS_SELECTOR, '.result-count').text
                    )
                )
                if expected:
                    card = driver.find_element(By.CSS_SELECTOR, '.listing-card')
                    assert 'Oct 19' in card.text and '12:00' in card.text, card.text
                    card.find_element(By.CSS_SELECTOR, '.card-title').click()
                    summary = wait.until(
                        lambda d: d.find_element(By.CSS_SELECTOR, '.event-schedule summary')
                    )
                    summary.click()
                    assert len(driver.find_elements(By.CSS_SELECTOR, '.event-schedule li')) > 10
                    screenshot_ready(evidence / f'visiting-{parsed.port}.png')
                    driver.find_element(By.TAG_NAME, 'body').send_keys(Keys.ESCAPE)
                    wait.until(lambda d: not d.find_elements(By.CSS_SELECTOR, '.detail-dialog'))
            visit_date('')
            search_for('DOME@HOME')
            wait.until(
                lambda d: (
                    len(d.find_elements(By.CSS_SELECTOR, '.listing-card')) == 2
                    and all(
                        'DOME@HOME' in c.text
                        for c in d.find_elements(By.CSS_SELECTOR, '.listing-card')
                    )
                )
            )
            cards = driver.find_elements(By.CSS_SELECTOR, '.listing-card')
            text = '\n'.join(c.text for c in cards)
            assert (
                'Oct 29' in text
                and 'Nov 26' in text
                and all('Recurring' in c.text and '7:00' in c.text for c in cards)
            ), text
            result = api('/api/listings?query=DOME%40HOME')['body']['items']
            assert (
                len(result) == 2
                and len({e['eventId'] for e in result}) == 1
                and len({e['id'] for e in result}) == 2
            )
            cards[0].find_element(By.CSS_SELECTOR, '.card-title').click()
            wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, '.detail-dialog'))
            wait.until(
                lambda d: d.execute_script(
                    'return [...document.querySelectorAll(".detail-dialog img")].filter(i=>i.offsetWidth>0).every(i=>i.complete&&i.naturalWidth>0)'
                )
            )
            screenshot_ready(evidence / f'recurring-{parsed.port}.png')
            driver.find_element(By.TAG_NAME, 'body').send_keys(Keys.ESCAPE)
            wait.until(lambda d: not d.find_elements(By.CSS_SELECTOR, '.detail-dialog'))
            search_for('The Paper Trail')
            wait.until(
                lambda d: (
                    len(d.find_elements(By.CSS_SELECTOR, '.listing-card')) > 1
                    and all(
                        'Paper Trail' in c.text
                        for c in d.find_elements(By.CSS_SELECTOR, '.listing-card')
                    )
                )
            )
            exhibition = api('/api/listings?query=The%20Paper%20Trail&limit=100')['body']
            assert exhibition['total'] > 1
            assert len({e['eventId'] for e in exhibition['items']}) == 1
            assert all(e['recurring'] and e['start'] == e['end'] for e in exhibition['items'])
            assert all(
                'May 1, 2026' not in c.text and 'Recurring' in c.text
                for c in driver.find_elements(By.CSS_SELECTOR, '.listing-card')
            )
            visit_date('2026-10-20')
            wait.until(
                lambda d: (
                    len(d.find_elements(By.CSS_SELECTOR, '.listing-card')) == 1
                    and 'Oct 20' in d.find_element(By.CSS_SELECTOR, '.listing-card').text
                )
            )
            driver.save_screenshot(str(evidence / f'exhibition-days-{parsed.port}.png'))
            visit_date('2026-10-19')
            wait.until(
                lambda d: (
                    len(d.find_elements(By.CSS_SELECTOR, '.listing-card')) == 0
                    and 'Checking sources'
                    not in d.find_element(By.CSS_SELECTOR, '.result-count').text
                )
            )
            visit_date('')
            search_for('Canada Life Centre')
            wait.until(
                lambda d: any(
                    'Via Canada Life Centre' in c.text
                    for c in d.find_elements(By.CSS_SELECTOR, '.listing-card')
                )
            )
            clc = api('/api/listings?query=Canada%20Life%20Centre&limit=100')['body']['items']
            clc = [e for e in clc if e['source'] == 'canada-life-centre']
            assert len(clc) > 1 and all(
                e['start'] <= '2026-11-30' and e['price'] is None for e in clc
            )
            card = next(
                c
                for c in driver.find_elements(By.CSS_SELECTOR, '.listing-card')
                if 'Via Canada Life Centre' in c.text
            )
            assert 'a.m.' in card.text or 'p.m.' in card.text, card.text
            assert card.find_elements(By.CSS_SELECTOR, '.social-placeholder')
            assert (
                'Canada Life Centre'
                in card.find_element(By.CSS_SELECTOR, '.social-placeholder').text
            )
            card.find_element(By.CSS_SELECTOR, '.card-title').click()
            wait.until(
                lambda d: (
                    'Canada Life Centre' in d.find_element(By.CSS_SELECTOR, '.detail-dialog').text
                )
            )
            assert (
                'See the event page' in driver.find_element(By.CSS_SELECTOR, '.detail-dialog').text
            )
            screenshot_ready(evidence / f'canada-life-centre-{parsed.port}.png')
            errors = [entry for entry in driver.get_log('browser') if entry['level'] == 'SEVERE']
            assert not errors, errors
            print(
                json.dumps(
                    {
                        'origin': origin,
                        'grid': True,
                        'visitingDatesAndClosures': True,
                        'unknownOutsideCoverage': True,
                        'sharedRecurringEvent': True,
                        'exhibitionVisitingDayCards': True,
                        'canadaLifeCentreCardsAndTimes': len(clc),
                        'photosLoaded': True,
                        'consoleErrors': 0,
                    }
                )
            )
    finally:
        driver.quit()
