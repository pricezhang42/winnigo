"""Synthetic session browser test. Requires setup-auth-qa and the QA server."""
import json,pathlib,subprocess,tempfile,time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
origin='http://127.0.0.1:5193';email='browser-'+str(time.time_ns())+'@example.test';password='Browser-synthetic-password-123'
subprocess.run(['node','--env-file=.winnigo/p3-qa.env','scripts/manage-accounts.mjs','invite',email],check=True,capture_output=True)
subprocess.run(['node','--env-file=.winnigo/p3-qa.env','scripts/reset-auth-qa-limits.mjs'],check=True,capture_output=True)
evidence=pathlib.Path('.winnigo/p3-evidence');evidence.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='winnigo-auth-') as profile:
 options=webdriver.ChromeOptions();options.page_load_strategy='eager';options.set_capability('goog:loggingPrefs',{'browser':'ALL'})
 for a in ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--window-size=1200,1000','--user-data-dir='+profile]:options.add_argument(a)
 d=webdriver.Chrome(options=options);w=WebDriverWait(d,30)
 def css(s):return w.until(lambda b:b.find_element(By.CSS_SELECTOR,s))
 def click(text):w.until(lambda b:next((e for e in b.find_elements(By.TAG_NAME,'button') if e.text==text and e.is_enabled()),False)).click()
 def mail(kind):
  def find(_):
   for f in pathlib.Path('.winnigo/p3-mail').glob('*.json'):
    m=json.loads(f.read_text())
    if m['to']==email and m['kind']==kind:return m['url']
   return False
  return w.until(find)
 def login(pw):
  d.get(origin+'/login');css('input[name=email]').send_keys(email);css('input[name=password]').send_keys(pw);click('Sign in');w.until(lambda b:b.current_url.rstrip('/')==origin)
 try:
  d.get(origin);w.until(lambda b:'/login' in b.current_url)
  assert d.execute_script("return getComputedStyle(document.querySelector('.account-shell')).maxWidth")=='520px'
  d.save_screenshot(str(evidence/'login.png'));click('I have an invitation')
  css('input[name=name]').send_keys('Synthetic Browser User');css('input[name=email]').send_keys(email);css('input[name=password]').send_keys(password);click('Create account')
  w.until(lambda b:'Check your email' in b.find_element(By.TAG_NAME,'main').text)
  d.get(mail('verify'));w.until(lambda b:'/login' in b.current_url);login(password)
  w.until(lambda b:'Checking sources' not in b.find_element(By.CSS_SELECTOR,'.result-count').text)
  css('.save-button').click();w.until(lambda b:len(b.find_elements(By.CSS_SELECTOR,'.save-button.is-saved'))==1)
  click('Community Highlights');w.until(lambda b:'0 discoveries' in b.find_element(By.CSS_SELECTOR,'.result-count').text)
  d.get(origin+'/account');w.until(lambda b:'Role: user' in b.find_element(By.TAG_NAME,'main').text);click('Sign out other devices');w.until(lambda b:len(b.find_elements(By.CSS_SELECTOR,'li'))==1)
  click('Sign out');w.until(lambda b:'/login' in b.current_url)
  click('Forgot password?');css('input[name=email]').send_keys(email);click('Send reset link');w.until(lambda b:'If that account exists' in b.find_element(By.TAG_NAME,'main').text)
  d.get(mail('reset'));w.until(lambda b:'/account/reset' in b.current_url);new_password='Replacement-browser-password-456';css('input[name=password]').send_keys(new_password);click('Reset password');w.until(lambda b:'Password changed' in b.find_element(By.TAG_NAME,'main').text)
  login(new_password);d.get(origin+'/account');w.until(lambda b:'Role: user' in b.find_element(By.TAG_NAME,'main').text)
  d.save_screenshot(str(evidence/'account.png'));click('Email deletion confirmation');w.until(lambda b:'Check your email' in b.find_element(By.TAG_NAME,'main').text)
  d.get(mail('delete'));w.until(lambda b:'/login' in b.current_url);d.get(origin);w.until(lambda b:'/login' in b.current_url)
  owner=json.loads((evidence/'browser-account.json').read_text());d.get(origin+'/login');css('input[name=email]').send_keys(owner['ownerEmail']);css('input[name=password]').send_keys(owner['password']);click('Sign in');w.until(lambda b:b.current_url.rstrip('/')==origin);click('Saved');w.until(lambda b:'0 discoveries' in b.find_element(By.CSS_SELECTOR,'.result-count').text)
  errors=[e for e in d.get_log('browser') if e.get('source')=='javascript' and e['level']=='SEVERE'];assert not errors
  report={'status':'passed','checks':['Styled login','Invited registration and email verification','Password sign-in','Private collection excluded','Session management and logout','Email password reset','Confirmed account deletion and session revocation','Device bookmarks isolated between accounts']};(evidence/'auth-browser.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
 except Exception:
  d.save_screenshot(str(evidence/'auth-failure.png'));raise
 finally:d.quit()
