#!/usr/bin/env python3
"""Collect visible Hiking Manitoba post candidates, without publishing or handling passwords."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import tempfile
import time
from urllib.parse import urlsplit, parse_qs, urlencode

from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / '.sites-runtime'
GROUP = '810758152436911'
GROUP_URL = f'https://www.facebook.com/groups/{GROUP}/?sorting_setting=CHRONOLOGICAL'
POST_ROOT = '[role="feed"] > *'
MESSAGES = '[data-ad-preview="message"], [data-ad-comet-preview="message"]'


def post_url(value):
    """Accept only canonical post permalinks within this group, never comment/profile links."""
    url = urlsplit(value)
    if url.scheme != 'https' or url.hostname not in {'facebook.com', 'www.facebook.com', 'm.facebook.com'}:
        return None
    match = re.fullmatch(rf'/groups/{GROUP}/(?:posts|permalink)/(\d+)/?', url.path)
    if not match:
        return None
    # A comment permalink still identifies the parent post; remove its query.
    return f'https://www.facebook.com/groups/{GROUP}/posts/{match[1]}/'


def redact_contacts(text):
    text = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[contact in original post]', text)
    return re.sub(r'(?<!\d)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)', '[contact in original post]', text)


def write_private(path, result):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.hiking-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def profile_lock():
    RUNTIME.mkdir(mode=0o700, exist_ok=True)
    with open(RUNTIME / 'hiking-selenium.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('The Selenium profile is already in use. Finish the other collector or login run first.')
        yield


def make_driver(profile, headless=False):
    profile = Path(profile).resolve()
    profile.mkdir(mode=0o700, parents=True, exist_ok=True)
    options = webdriver.ChromeOptions()
    options.add_argument(f'--user-data-dir={profile}')
    options.add_argument('--disable-notifications')
    options.add_argument('--no-first-run')
    options.add_argument('--window-size=1440,1100')
    if headless:
        options.add_argument('--headless=new')
    options.page_load_strategy = 'eager'
    # Selenium Manager finds a matching driver. No stealth flags, cookie copying or remote debugging.
    driver = webdriver.Chrome(options=options)
    driver.set_page_load_timeout(45)
    driver.set_script_timeout(15)
    return driver


def access_problem(driver):
    if re.search(r'/checkpoint|/challenge|/login|/recover', urlsplit(driver.current_url).path):
        return 'Facebook requires sign-in or an account check in the Selenium Chrome profile.'
    if any(e.is_displayed() for e in driver.find_elements(By.CSS_SELECTOR, 'input[type="password"]')):
        return 'Sign in to Facebook in the Selenium Chrome profile.'
    page = driver.find_element(By.TAG_NAME, 'body').text.lower()
    if any(s in page for s in ['temporarily blocked', 'you’re temporarily blocked', "you're temporarily blocked", 'confirm you are human', 'confirm your identity']):
        return 'Facebook blocked access or requires a verification step. Collection stopped.'
    return None


def group_ready(driver):
    if access_problem(driver):
        return False
    return any('Hiking Manitoba' in e.text for e in driver.find_elements(By.CSS_SELECTOR, 'h1')) and bool(driver.find_elements(By.CSS_SELECTOR, '[role="feed"]'))


def candidates_on_screen(driver):
    """Only visible post message nodes; exclude comment articles, profiles and sidebar content."""
    return driver.execute_script(r'''
      const out=[];
      for (const article of document.querySelectorAll(arguments[0])) {
        // Current Facebook feed roots are plain divs; role=article is used for comments.
        const blocks=[...article.querySelectorAll(arguments[1])].filter(n=>n.getClientRects().length && (!n.closest('[role="article"]') || n.closest('[role="article"]')===article));
        const text=blocks.map(n=>n.innerText).filter(Boolean).join('\n');

        const links=[...article.querySelectorAll('a[href]')].filter(a=>a.getClientRects().length).map(a=>a.href);
        const comments=[...article.querySelectorAll('[role="article"]')].slice(0,30).map(c=>({
          text:[...c.querySelectorAll('[lang]')].filter(n=>n.closest('[role="article"]')===c&&!n.querySelector('[lang]')).map(n=>n.innerText).join(' ').slice(0,2000),
          url:[...c.querySelectorAll('a[href]')].find(a=>a.href.includes('comment_id='))?.href||''
        })).filter(c=>c.text&&c.url);
        const photos=[...article.querySelectorAll('a[href*="/photo"]')].filter(a=>!a.closest('[role="article"]')).flatMap(a=>[...a.querySelectorAll('img')].filter(i=>i.width>100&&i.height>100).map(i=>({url:i.currentSrc,sourceUrl:a.href}))).slice(0,20);
        if(!text&&!photos.length&&!comments.length)continue;
        out.push({text:text.slice(0,8000),links,comments,photos});
      }
      return out;
    ''', POST_ROOT, MESSAGES)


def expand_posts(driver, expanded):
    roots = driver.execute_script("return [...document.querySelectorAll(arguments[0])].filter(n=>{const r=n.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight*1.5})", POST_ROOT)
    for root in roots:
        try:
            # Hovering Facebook's timestamp resolves its lazy permalink without opening a profile.
            for link in root.find_elements(By.CSS_SELECTOR, 'a[href]'):
                href=link.get_attribute('href') or ''
                if urlsplit(href).path == f'/groups/{GROUP}/' and link.is_displayed() and driver.execute_script('const r=arguments[0].getBoundingClientRect();return r.top>=0&&r.bottom<innerHeight',link):
                    ActionChains(driver).move_to_element(link).perform()
                    break
            clicks=0
            for button in root.find_elements(By.CSS_SELECTOR, '[role="button"],button'):
                if not button.is_displayed() or button.id in expanded:
                    continue
                label=button.text.strip()
                if label=='See more' and driver.execute_script('const r=arguments[0].getBoundingClientRect();return r.top>=0&&r.bottom<innerHeight',button):
                    expanded.add(button.id)
                    button.click()
                    clicks+=1
                    if clicks>=4:break
        except WebDriverException:
            continue


def collect(driver, limit=100, scrolls=80):
    driver.get(GROUP_URL)
    try:
        WebDriverWait(driver, 25).until(lambda d: group_ready(d) or access_problem(d))
    except TimeoutException:
        return {'status':'blocked','message':'Group feed not found. Membership, page layout or session needs attention.','posts':[]}
    if problem := access_problem(driver):
        return {'status':'blocked','message':problem,'posts':[]}
    # Query parameters alone do not prove sort order; verify the rendered control.
    if not any('New posts' in e.text for e in driver.find_elements(By.CSS_SELECTOR, '[role="button"],h2')):
        return {'status':'blocked','message':'Could not verify New posts ordering. No posts collected.','posts':[]}
    posts = {}
    expanded=set()
    started=time.monotonic()
    unlinked = set()
    status, message = 'partial', 'Scroll limit reached; this is a partial check.'
    for turn in range(scrolls + 1):
        if problem := access_problem(driver):
            status, message = ('partial' if posts else 'blocked'), problem
            break
        if time.monotonic()-started>300:
            message='Five-minute collection limit reached; this is a partial check.'
            break
        expand_posts(driver, expanded)
        for item in candidates_on_screen(driver):
            links = list(dict.fromkeys(filter(None, (post_url(link) for link in item['links']))))
            if len(links) != 1:
                unlinked.add(item['text'])
                continue
            comments=[]
            for comment in item.get('comments',[]):
                if post_url(comment['url'])!=links[0]:continue
                query=parse_qs(urlsplit(comment['url']).query)
                identity={k:query[k][0] for k in ['comment_id','reply_comment_id'] if k in query and query[k][0].isdigit()}
                comments.append({'text':redact_contacts(comment['text']),'url':links[0]+'?'+urlencode(identity)})
            photos=[p for p in item.get('photos',[]) if urlsplit(p['url']).scheme=='https' and (urlsplit(p['url']).hostname or '').endswith('.fbcdn.net')]
            old=posts.get(links[0],{})
            merged_comments={x['url']:x for x in old.get('comments',[])+comments}
            merged_photos={x['sourceUrl']:x for x in old.get('photos',[])+photos}
            posts[links[0]] = {'url':links[0], 'text':redact_contacts(item['text']), 'comments':list(merged_comments.values())[:30], 'photos':list(merged_photos.values())[:20], 'sourceVisibility':'private'}
            if len(posts) >= limit:
                break
        if turn%10==0:print(json.dumps({'scroll':turn,'linkedPosts':len(posts)}),flush=True)
        if len(posts) >= limit:
            status, message = 'ok', f'Collected the {limit} newest linked post candidates.'
            break
        # Stalled loading is never interpreted as proof that all group posts were read.
        if turn < scrolls:
            driver.execute_script('window.scrollBy(0, Math.max(600, window.innerHeight * 0.85))')
            time.sleep(1.5)
    if unlinked:
        status = 'partial'
        message += ' Some visible posts lacked an unambiguous permalink and were skipped.'
    if not posts and status != 'blocked':
        status, message = 'blocked', 'No supported post messages and permalinks found; selectors may need updating.'
    return {'status':status,'message':message,'posts':list(posts.values())[:limit]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--login', action='store_true', help='Open a dedicated Chrome window for you to sign in manually.')
    parser.add_argument('--headless', action='store_true')
    parser.add_argument('--limit', type=int, choices=range(1,101), default=100, metavar='1..100')
    parser.add_argument('--max-scrolls', type=int, choices=range(0,81), default=80, metavar='0..80')
    parser.add_argument('--output', type=Path, default=RUNTIME/'hiking-candidates.json')
    args = parser.parse_args()
    if args.login and args.headless:
        parser.error('--login needs a visible browser')
    result = {'status':'blocked','message':'Collector did not complete.','posts':[]}
    driver = None
    try:
        with profile_lock():
            try:
                driver = make_driver(RUNTIME/'hiking-chrome-profile', args.headless)
                if args.login:
                    driver.get(GROUP_URL)
                    print('Sign in directly in the Selenium Chrome window, then open Hiking Manitoba. Waiting up to 10 minutes.', flush=True)
                    WebDriverWait(driver, 600, poll_frequency=2).until(group_ready)
                    print('The dedicated profile can access Hiking Manitoba. Login setup complete.', flush=True)
                    return 0
                result = collect(driver, args.limit, args.max_scrolls)
            finally:
                if driver:
                    driver.quit()
    except TimeoutException:
        result['message'] = 'Sign-in or page loading timed out. Run --login to complete setup.'
    except (WebDriverException, RuntimeError) as error:
        # Browser exception dumps may contain page data or sensitive local paths; do not persist them.
        result['message'] = f'Browser unavailable ({type(error).__name__}). Check Chrome, the driver and profile access.'
    result['checkedAt'] = datetime.now(timezone.utc).isoformat()
    result['groupUrl'] = GROUP_URL
    write_private(args.output, result)
    print(json.dumps({'status':result['status'],'candidates':len(result['posts']),'comments':sum(len(p.get('comments',[])) for p in result['posts']),'photos':sum(len(p.get('photos',[])) for p in result['posts']),'message':result['message']}))
    return 2 if result['status']=='blocked' else 0


if __name__ == '__main__':
    raise SystemExit(main())
