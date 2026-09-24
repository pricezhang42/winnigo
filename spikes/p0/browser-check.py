"""Selenium QA against disposable P0 services. Never uses the collector profile."""
import argparse, json, pathlib, re, tempfile
from urllib.parse import quote
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait

p=argparse.ArgumentParser()
p.add_argument('--legacy-checkout', required=True)
p.add_argument('--legacy-port', type=int, default=5177)
p.add_argument('--next-port', type=int, default=5188)
p.add_argument('--evidence', default='evidence')
a=p.parse_args()
root=pathlib.Path(a.legacy_checkout).resolve()
assert re.fullmatch(r'/tmp/winnigo-p0-legacy\.[a-zA-Z0-9]+',str(root)), 'Disposable checkout required'
evidence=pathlib.Path(a.evidence);evidence.mkdir(parents=True,exist_ok=True)
values={}
for line in (root/'.dev.vars').read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1);values[k]=v.strip('"')
checks=[]
with tempfile.TemporaryDirectory(prefix='winnigo-p0-browser-') as profile:
 o=webdriver.ChromeOptions();o.page_load_strategy='eager'
 for arg in ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--window-size=1440,1050','--user-data-dir='+profile]:o.add_argument(arg)
 d=webdriver.Chrome(options=o);w=WebDriverWait(d,30)
 def css(selector):return w.until(lambda b:b.find_element(By.CSS_SELECTOR,selector))
 def click_text(text,scope=''):
  element=w.until(lambda b:next((x for x in b.find_elements(By.CSS_SELECTOR,scope+'button') if x.is_displayed() and x.text.strip()==text),False))
  d.execute_script('arguments[0].scrollIntoView({block:"center"})',element);element.click()
 def close_dialog():d.find_element(By.TAG_NAME,'body').send_keys(Keys.ESCAPE)
 def loaded():w.until(lambda b:'Checking sources' not in b.find_element(By.CSS_SELECTOR,'.result-count').text)
 try:
  d.get(f'http://127.0.0.1:{a.next_port}')
  css('button').click();w.until(lambda b:'check: 1' in b.find_element(By.TAG_NAME,'button').text)
  assert d.execute_script("return getComputedStyle(document.querySelector('.probe-grid')).display")=='grid'
  d.get(f'http://127.0.0.1:{a.next_port}/api/probe')
  assert json.loads(d.find_element(By.TAG_NAME,'body').text)['imports']
  checks.append('Next production CSS grid, hydration and Node server imports')
  origin=f'http://127.0.0.1:{a.legacy_port}'
  user=quote(values['WINNIGO_ADMIN_USER'],safe='');password=quote(values['WINNIGO_ADMIN_PASSWORD'],safe='')
  d.get(origin.replace('://',f'://{user}:{password}@'))
  d.get(origin);loaded()
  assert d.execute_script("return getComputedStyle(document.querySelector('.cards')).display")=='grid'
  assert d.execute_script("return getComputedStyle(document.querySelector('.topbar')).display")=='flex'
  d.save_screenshot(str(evidence/'legacy-discovery.png'))
  checks.append('Legacy CSS grid/topbar and completed client loading')
  click_text('Community Highlights','.collection-filters ')
  w.until(lambda b:'P0 Betula Lake outing' in b.find_element(By.CSS_SELECTOR,'.cards').text)
  assert 'P0 hidden fixture' not in css('.cards').text
  assert 'P0 owner correction' in css('.cards').text
  search=css('input[aria-label="Search events, places, or activities"]');search.send_keys('P0 Betula')
  w.until(lambda b:'1 discovery' in css('.result-count').text)
  css('.card-title').click()
  assert 'general area' in css('.detail-dialog').get_attribute('textContent')
  assert 'parking details are unconfirmed' in css('.comment-notes').text
  assert 'comment_id=' in css('.comment-notes a').get_attribute('href')
  css('.gallery-cover').click()
  w.until(lambda b:b.execute_script("return [...document.querySelectorAll('.full-photo img')].every(i=>i.complete && i.naturalWidth>0)"))
  css('.gallery-next').click();w.until(lambda b:'2 / 2' in css('.gallery-footer').text)
  css('.gallery-prev').click();w.until(lambda b:'1 / 2' in css('.gallery-footer').text)
  d.save_screenshot(str(evidence/'legacy-gallery.png'))
  close_dialog();w.until(lambda b:len(b.find_elements(By.CSS_SELECTOR,'.photo-viewer'))==0)
  close_dialog();w.until(lambda b:len(b.find_elements(By.CSS_SELECTOR,'.detail-dialog'))==0)
  checks.append('Community/search filters, hidden/override preservation, approximate warning, comments, full photos and navigation')
  click_text('Trail map','nav ')
  click_text('Community Highlights','.collection-filters ')
  marker=css('.trail-pin.approximate');marker.click()
  # Both visible fixture posts share the lake point; marker opens their picker.
  css('.map-group-popup button').click();assert 'general area' in css('.detail-dialog').get_attribute('textContent')
  close_dialog();w.until(lambda b:len(b.find_elements(By.CSS_SELECTOR,'.detail-dialog'))==0)
  d.save_screenshot(str(evidence/'legacy-map.png'))
  checks.append('Interactive Leaflet map, grouped approximate lake marker and detail selection')
  # Known baseline defect: unmounting Leaflet during zoom can throw _leaflet_pos.
  # Reload here so the remaining independent workflows can be verified.
  d.get(origin);loaded();click_text('Official Trails','.collection-filters ')
  css('.card-title').click();assert 'Summer map' in css('.official-details').get_attribute('textContent')
  assert 'Winter map' in css('.official-details').get_attribute('textContent')
  close_dialog();w.until(lambda b:len(b.find_elements(By.CSS_SELECTOR,'.detail-dialog'))==0)
  click_text('Meet the sources');assert 'Trails Manitoba' in css('[role="dialog"]').get_attribute('textContent')
  close_dialog()
  checks.append('Official trail seasonal details and source dialog')
  d.get(origin+'/admin')
  w.until(lambda b:len(b.find_elements(By.CSS_SELECTOR,'.admin-sources > div'))>0)
  css('input[aria-label="Search collection"]').send_keys('P0 Betula')
  w.until(lambda b:len(b.find_elements(By.CSS_SELECTOR,'.admin-list > div'))==1)
  click_text('Edit','.admin-list ')
  title=css('#edit-title');title.send_keys(Keys.CONTROL+'a');title.send_keys('P0 browser correction')
  click_text('Save corrections');w.until(lambda b:len(b.find_elements(By.CSS_SELECTOR,'#edit-title'))==0)
  search=css('input[aria-label="Search collection"]');search.send_keys(Keys.CONTROL+'a');search.send_keys('P0 browser correction')
  css('button[aria-label="Hide P0 browser correction"]').click()
  css('button[aria-label="Show P0 browser correction"]').click()
  css('button[aria-label="Hide P0 browser correction"]')
  assert len(d.find_elements(By.CSS_SELECTOR,'.admin-sources > div'))>0
  # Restore the synthetic title for a repeatable run.
  click_text('Edit','.admin-list ')
  title=css('#edit-title');title.send_keys(Keys.CONTROL+'a');title.send_keys('P0 Betula Lake outing')
  click_text('Save corrections');w.until(lambda b:len(b.find_elements(By.CSS_SELECTOR,'#edit-title'))==0)
  checks.append('Admin source status, edit persistence and hide/show')
  report={'status':'passed-with-known-issue','browser':d.capabilities['browserVersion'],'legacyPort':a.legacy_port,'checks':checks,'knownIssues':['Changing map filters or leaving the map during zoom can throw _leaflet_pos; remaining checks use a reload.']}
  (evidence/'browser.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
 except Exception:
  d.save_screenshot(str(evidence/'failure.png'))
  raise
 finally:d.quit()
