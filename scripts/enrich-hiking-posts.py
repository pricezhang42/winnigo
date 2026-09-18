#!/usr/bin/env python3
"""Read comments and full-size post photos for selected, already-discovered group posts."""
import argparse
import importlib.util
import json
import re
import time
from pathlib import Path
from urllib.parse import urlsplit,parse_qs,urlencode

spec=importlib.util.spec_from_file_location('collector',Path(__file__).with_name('collect-hiking-selenium.py'))
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

def enrich(driver, post):
    target=c.post_url(post['url'])
    if not target:raise ValueError('Use a previously collected Hiking Manitoba post link.')
    driver.get(target)
    c.WebDriverWait(driver,25).until(lambda d:d.find_elements(c.By.CSS_SELECTOR,c.MESSAGES) or c.access_problem(d))
    if problem:=c.access_problem(driver):raise RuntimeError(problem)
    time.sleep(1)
    # Opening threads here cannot interrupt the separate chronological feed scan.
    seen=set()
    for _ in range(6):
        candidates=driver.find_elements(c.By.CSS_SELECTOR,'[role="dialog"] [role="button"], [role="feed"] [role="button"]')
        clicked=False
        for button in candidates:
            try:
                label=button.text.strip()
                if button.id in seen or not button.is_displayed():continue
                if label=='See more' or re.fullmatch(r'View (?:\d+ |more |all )?(?:comments?|answers?|repl(?:y|ies))',label,re.I):
                    seen.add(button.id);button.click();time.sleep(.4);clicked=True;break
            except c.WebDriverException:continue
        if not clicked:break
    selector='[role="dialog"]' if driver.find_elements(c.By.CSS_SELECTOR,'[role="dialog"]') else c.POST_ROOT
    # The collection function reads only rendered message, comment, and photo elements.
    old_selector=c.POST_ROOT;c.POST_ROOT=selector
    try:rows=c.candidates_on_screen(driver)
    finally:c.POST_ROOT=old_selector
    for row in rows:
        identities=set(filter(None,(c.post_url(link) for link in row['links'])))
        if target not in identities:continue
        if row['text']:post['text']=c.redact_contacts(row['text'])
        comments={x['url']:x for x in post.get('comments',[])}
        for note in row.get('comments',[]):
            if c.post_url(note['url'])!=target:continue
            query=parse_qs(urlsplit(note['url']).query)
            identity={k:query[k][0] for k in ['comment_id','reply_comment_id'] if k in query and query[k][0].isdigit()}
            url=target+'?'+urlencode(identity)
            comments[url]={'text':c.redact_contacts(note['text']),'url':url}
        post['comments']=list(comments.values())[:30]
        photos={x['sourceUrl']:x for x in post.get('photos',[])}
        for photo in row.get('photos',[]):photos[photo['sourceUrl']]=photo
        post['photos']=list(photos.values())[:20]
    for photo in post.get('photos',[])[:20]:
        source=urlsplit(photo['sourceUrl'])
        if source.scheme!='https' or source.hostname not in ['www.facebook.com','facebook.com'] or source.path not in ['/photo/','/photo.php']:continue
        try:
            driver.get(photo['sourceUrl'])
            def full_image(d):
                if c.access_problem(d):return None
                return d.execute_script('''
                  return [...document.images].filter(i=>i.complete&&i.naturalWidth>=400&&i.getBoundingClientRect().width>=300&&i.getBoundingClientRect().height>=200&&i.currentSrc.includes('.fbcdn.net/'))
                   .sort((a,b)=>(b.getBoundingClientRect().width*b.getBoundingClientRect().height)-(a.getBoundingClientRect().width*a.getBoundingClientRect().height))[0]?.currentSrc;
                ''')
            image=c.WebDriverWait(driver,12).until(full_image)
            photo['url']=image;photo['resolution']='viewer'
        except c.TimeoutException:
            photo['resolution']='preview'
        if c.access_problem(driver):raise RuntimeError('Facebook requires attention; photo reading stopped.')
    return post

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--post-url',action='append',required=True)
    args=parser.parse_args()
    candidates=json.loads((c.RUNTIME/'hiking-candidates.json').read_text())
    targets={c.post_url(x) for x in args.post_url}
    posts=[p for p in candidates['posts'] if p['url'] in targets]
    if len(posts)!=len(targets) or len(posts)>15:raise ValueError('Select 1–15 posts from this run’s candidates.')
    with c.profile_lock():
        driver=c.make_driver(c.RUNTIME/'hiking-chrome-profile',True)
        try:
            for post in posts:
                enrich(driver,post)
                c.write_private(c.RUNTIME/'hiking-enriched.json',{'status':candidates['status'],'checkedAt':candidates['checkedAt'],'posts':posts})
                print(json.dumps({'url':post['url'],'comments':len(post.get('comments',[])),'photos':len(post.get('photos',[]))}),flush=True)
        finally:driver.quit()

if __name__=='__main__':main()
