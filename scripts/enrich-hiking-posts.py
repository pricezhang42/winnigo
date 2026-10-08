#!/usr/bin/env python3
"""Read comments and full-size post photos for selected, already-discovered group posts."""

import argparse
import importlib.util
import json
import re
import time
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, urlencode

spec = importlib.util.spec_from_file_location(
    'collector', Path(__file__).with_name('collect-hiking-selenium.py')
)
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def enrich(driver, post):
    target = collector.post_url(post['url'])
    if not target:
        raise ValueError('Use a previously collected Hiking Manitoba post link.')
    driver.get(target)
    collector.WebDriverWait(driver, 25).until(
        lambda browser: (
            browser.find_elements(collector.By.CSS_SELECTOR, collector.MESSAGES)
            or collector.access_problem(browser)
        )
    )
    if problem := collector.access_problem(driver):
        raise RuntimeError(problem)
    time.sleep(1)
    # Opening threads here cannot interrupt the separate chronological feed scan.
    seen = set()
    for _ in range(6):
        candidates = driver.find_elements(
            collector.By.CSS_SELECTOR,
            '[role="dialog"] [role="button"], [role="feed"] [role="button"]',
        )
        clicked = False
        for button in candidates:
            try:
                label = button.text.strip()
                if button.id in seen or not button.is_displayed():
                    continue
                if label == 'See more' or re.fullmatch(
                    r'View (?:\d+ |more |all )?(?:comments?|answers?|repl(?:y|ies))', label, re.I
                ):
                    seen.add(button.id)
                    button.click()
                    time.sleep(0.4)
                    clicked = True
                    break
            except collector.WebDriverException:
                continue
        if not clicked:
            break
    selector = (
        '[role="dialog"]'
        if driver.find_elements(collector.By.CSS_SELECTOR, '[role="dialog"]')
        else collector.POST_ROOT
    )
    # The collection function reads only rendered message, comment, and photo elements.
    old_selector = collector.POST_ROOT
    collector.POST_ROOT = selector
    try:
        rows = collector.candidates_on_screen(driver)
    finally:
        collector.POST_ROOT = old_selector
    for row in rows:
        identities = set(filter(None, (collector.post_url(link) for link in row['links'])))
        if target not in identities:
            continue
        if row['text']:
            post['text'] = collector.redact_contacts(row['text'])
        comments = {item['url']: item for item in post.get('comments', [])}
        for note in row.get('comments', []):
            if collector.post_url(note['url']) != target:
                continue
            query = parse_qs(urlsplit(note['url']).query)
            identity = {
                key: query[key][0]
                for key in ['comment_id', 'reply_comment_id']
                if key in query and query[key][0].isdigit()
            }
            url = target + '?' + urlencode(identity)
            comments[url] = {'text': collector.redact_contacts(note['text']), 'url': url}
        post['comments'] = list(comments.values())[:30]

        def photo_key(photo):
            return parse_qs(urlsplit(photo['sourceUrl']).query).get('fbid', [photo['sourceUrl']])[0]

        photos = {photo_key(item): item for item in post.get('photos', [])}
        for photo in row.get('photos', []):
            photos[photo_key(photo)] = photo
        post['photos'] = list(photos.values())[:20]
    for photo in post.get('photos', [])[:20]:
        source = urlsplit(photo['sourceUrl'])
        if (
            source.scheme != 'https'
            or source.hostname not in ['www.facebook.com', 'facebook.com']
            or source.path not in ['/photo/', '/photo.php']
        ):
            continue
        try:
            driver.get(photo['sourceUrl'])

            def full_image(browser):
                if collector.access_problem(browser):
                    return None
                return browser.execute_script("""
                  return [...document.images].filter(i=>i.complete&&i.naturalWidth>=400&&i.getBoundingClientRect().width>=300&&i.getBoundingClientRect().height>=200&&i.currentSrc.includes('.fbcdn.net/'))
                   .sort((a,b)=>(b.getBoundingClientRect().width*b.getBoundingClientRect().height)-(a.getBoundingClientRect().width*a.getBoundingClientRect().height))[0]?.currentSrc;
                """)

            image = collector.WebDriverWait(driver, 12).until(full_image)
            photo['url'] = image
            photo['resolution'] = 'viewer'
        except collector.TimeoutException:
            photo['resolution'] = 'preview'
        if collector.access_problem(driver):
            raise RuntimeError('Facebook requires attention; photo reading stopped.')
    return post


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--post-url', action='append', required=True)
    args = parser.parse_args()
    candidates = json.loads((collector.RUNTIME / 'hiking-candidates.json').read_text())
    targets = {collector.post_url(item) for item in args.post_url}
    posts = [candidate for candidate in candidates['posts'] if candidate['url'] in targets]
    if len(posts) != len(targets) or len(posts) > 15:
        raise ValueError('Select 1–15 posts from this run’s candidates.')
    with collector.profile_lock():
        driver = collector.make_driver(collector.RUNTIME / 'hiking-chrome-profile', True)
        try:
            for post in posts:
                enrich(driver, post)
                collector.write_private(
                    collector.RUNTIME / 'hiking-enriched.json',
                    {
                        'status': candidates['status'],
                        'checkedAt': candidates['checkedAt'],
                        'posts': posts,
                    },
                )
                print(
                    json.dumps(
                        {
                            'url': post['url'],
                            'comments': len(post.get('comments', [])),
                            'photos': len(post.get('photos', [])),
                        }
                    ),
                    flush=True,
                )
        finally:
            driver.quit()


if __name__ == '__main__':
    main()
