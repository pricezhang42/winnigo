import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
from urllib.parse import quote

spec = importlib.util.spec_from_file_location('collector', Path(__file__).parents[1]/'collect-hiking-selenium.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class CollectorTests(unittest.TestCase):
    def test_only_this_groups_posts_are_accepted(self):
        self.assertEqual(collector.post_url('https://www.facebook.com/groups/810758152436911/posts/123/?comment_id=456'), 'https://www.facebook.com/groups/810758152436911/posts/123/')
        for url in ['https://facebook.com.evil.test/groups/810758152436911/posts/123/', 'https://facebook.com/groups/another/posts/123/', 'https://facebook.com/groups/810758152436911/user/123/', 'http://facebook.com/groups/810758152436911/posts/123/']:
            self.assertIsNone(collector.post_url(url))

    def test_contacts_removed_but_distance_preserved(self):
        text=collector.redact_contacts('Hike 6 km. Email trail@example.com or call (204) 555-1234.')
        self.assertIn('6 km',text)
        self.assertNotIn('trail@example.com',text)
        self.assertNotIn('555-1234',text)

    def test_candidate_file_is_private(self):
        with tempfile.TemporaryDirectory() as temp:
            output=Path(temp)/'candidates.json'
            collector.write_private(output,{'posts':[]})
            self.assertEqual(stat.S_IMODE(output.stat().st_mode),0o600)
            self.assertEqual(json.loads(output.read_text()),{'posts':[]})

    def test_real_browser_separates_comments_photos_and_profiles(self):
        with tempfile.TemporaryDirectory() as temp:
            driver=collector.make_driver(Path(temp)/'profile',headless=True)
            try:
                driver.get('data:text/html;charset=utf-8,'+quote('''
                  <h1>Hiking Manitoba</h1><div role="feed"><div>
                    <h2>Do not collect this author's name</h2>
                    <a href="https://www.facebook.com/groups/810758152436911/posts/123/">Today</a>
                    <div data-ad-preview="message">Bear Lake route: 6 km.</div>
                    <div role="article"><a href="https://www.facebook.com/groups/810758152436911/posts/123/?comment_id=456">Today</a><span lang="en">Useful route detail in a comment.</span><div data-ad-preview="message">Keep comments out of post text.</div></div>
                    <a href="https://www.facebook.com/photo/?fbid=456"><img width="500" height="300" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII="/></a>
                  </div></div><aside data-ad-preview="message">Do not collect this sidebar.</aside>
                '''))
                candidates=collector.candidates_on_screen(driver)
                self.assertEqual(len(candidates),1)
                self.assertEqual(candidates[0]['text'],'Bear Lake route: 6 km.')
                self.assertEqual(candidates[0]['comments'][0]['text'],'Useful route detail in a comment.')
                self.assertEqual(len(candidates[0]['photos']),1)
                self.assertEqual(collector.post_url(candidates[0]['links'][0]),'https://www.facebook.com/groups/810758152436911/posts/123/')
            finally:
                driver.quit()


if __name__=='__main__':
    unittest.main()
