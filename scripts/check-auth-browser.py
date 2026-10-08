"""Synthetic session browser test. Requires setup-auth-qa and the QA server."""

import json, pathlib, subprocess, tempfile, time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

origin = 'http://127.0.0.1:5193'
email = 'browser-' + str(time.time_ns()) + '@example.test'
password = 'Browser-synthetic-password-123'
subprocess.run(
    ['node', '--env-file=.winnigo/p3-qa.env', 'scripts/manage-accounts.mjs', 'invite', email],
    check=True,
    capture_output=True,
)
subprocess.run(
    ['node', '--env-file=.winnigo/p3-qa.env', 'scripts/reset-auth-qa-limits.mjs'],
    check=True,
    capture_output=True,
)
evidence = pathlib.Path('.winnigo/p3-evidence')
evidence.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='winnigo-auth-') as profile:
    options = webdriver.ChromeOptions()
    options.page_load_strategy = 'eager'
    options.set_capability('goog:loggingPrefs', {'browser': 'ALL'})
    for argument in [
        '--headless=new',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1200,1000',
        '--user-data-dir=' + profile,
    ]:
        options.add_argument(argument)
    driver = webdriver.Chrome(options=options)
    wait = WebDriverWait(driver, 30)

    def css(selector):
        return wait.until(lambda browser: browser.find_element(By.CSS_SELECTOR, selector))

    def click(text):
        wait.until(
            lambda browser: next(
                (
                    e
                    for e in browser.find_elements(By.TAG_NAME, 'button')
                    if e.text == text and e.is_enabled()
                ),
                False,
            )
        ).click()

    def mail(kind):
        def find(_):
            for file in pathlib.Path('.winnigo/p3-mail').glob('*.json'):
                message = json.loads(file.read_text())
                if message['to'] == email and message['kind'] == kind:
                    return message['url']
            return False

        return wait.until(find)

    def login(login_password):
        driver.get(origin + '/login')
        css('input[name=email]').send_keys(email)
        css('input[name=password]').send_keys(login_password)
        click('Sign in')
        wait.until(lambda browser: browser.current_url.rstrip('/') == origin)

    try:
        driver.get(origin)
        wait.until(lambda browser: '/login' in browser.current_url)
        assert (
            driver.execute_script(
                "return getComputedStyle(document.querySelector('.account-shell')).maxWidth"
            )
            == '520px'
        )
        driver.save_screenshot(str(evidence / 'login.png'))
        click('I have an invitation')
        css('input[name=name]').send_keys('Synthetic Browser User')
        css('input[name=email]').send_keys(email)
        css('input[name=password]').send_keys(password)
        click('Create account')
        wait.until(
            lambda browser: 'Check your email' in browser.find_element(By.TAG_NAME, 'main').text
        )
        driver.get(mail('verify'))
        wait.until(lambda browser: '/login' in browser.current_url)
        login(password)
        wait.until(
            lambda browser: (
                'Checking sources'
                not in browser.find_element(By.CSS_SELECTOR, '.result-count').text
            )
        )
        css('.save-button').click()
        wait.until(
            lambda browser: (
                len(browser.find_elements(By.CSS_SELECTOR, '.save-button.is-saved')) == 1
            )
        )
        click('Community Highlights')
        wait.until(
            lambda browser: (
                '0 discoveries' in browser.find_element(By.CSS_SELECTOR, '.result-count').text
            )
        )
        driver.get(origin + '/account')
        wait.until(lambda browser: 'Role: user' in browser.find_element(By.TAG_NAME, 'main').text)
        click('Sign out other devices')
        wait.until(lambda browser: len(browser.find_elements(By.CSS_SELECTOR, 'li')) == 1)
        click('Sign out')
        wait.until(lambda browser: '/login' in browser.current_url)
        click('Forgot password?')
        css('input[name=email]').send_keys(email)
        click('Send reset link')
        wait.until(
            lambda browser: (
                'If that account exists' in browser.find_element(By.TAG_NAME, 'main').text
            )
        )
        driver.get(mail('reset'))
        wait.until(lambda browser: '/account/reset' in browser.current_url)
        new_password = 'Replacement-browser-password-456'
        css('input[name=password]').send_keys(new_password)
        click('Reset password')
        wait.until(
            lambda browser: 'Password changed' in browser.find_element(By.TAG_NAME, 'main').text
        )
        login(new_password)
        driver.get(origin + '/account')
        wait.until(lambda browser: 'Role: user' in browser.find_element(By.TAG_NAME, 'main').text)
        driver.save_screenshot(str(evidence / 'account.png'))
        click('Email deletion confirmation')
        wait.until(
            lambda browser: 'Check your email' in browser.find_element(By.TAG_NAME, 'main').text
        )
        driver.get(mail('delete'))
        wait.until(lambda browser: '/login' in browser.current_url)
        driver.get(origin)
        wait.until(lambda browser: '/login' in browser.current_url)
        owner = json.loads((evidence / 'browser-account.json').read_text())
        driver.get(origin + '/login')
        css('input[name=email]').send_keys(owner['ownerEmail'])
        css('input[name=password]').send_keys(owner['password'])
        click('Sign in')
        wait.until(lambda browser: browser.current_url.rstrip('/') == origin)
        click('Saved')
        wait.until(
            lambda browser: (
                '0 discoveries' in browser.find_element(By.CSS_SELECTOR, '.result-count').text
            )
        )
        errors = [
            e
            for e in driver.get_log('browser')
            if e.get('source') == 'javascript' and e['level'] == 'SEVERE'
        ]
        assert not errors
        report = {
            'status': 'passed',
            'checks': [
                'Styled login',
                'Invited registration and email verification',
                'Password sign-in',
                'Private collection excluded',
                'Session management and logout',
                'Email password reset',
                'Confirmed account deletion and session revocation',
                'Device bookmarks isolated between accounts',
            ],
        }
        (evidence / 'auth-browser.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
    except Exception:
        driver.save_screenshot(str(evidence / 'auth-failure.png'))
        raise
    finally:
        driver.quit()
