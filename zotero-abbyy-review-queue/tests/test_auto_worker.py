import unittest

from test_queue import QueueTests, q


class AutoWorkerTests(QueueTests):
    def setUp(self):
        super().setUp()
        self.cfg.update({"autoEnabled": True, "autoPublish": True})

    def auto(self, **extra):
        return self.engine.auto({**self.req, "action": "auto", "automatic": True, **extra})

    def test_auto_requires_both_switches_and_marker(self):
        self.cfg["autoEnabled"] = False
        with self.assertRaises(q.SafetyError):
            self.auto()
        self.cfg["autoEnabled"] = True
        self.cfg["autoPublish"] = False
        with self.assertRaises(q.SafetyError):
            self.auto()
        self.cfg["autoPublish"] = True
        with self.assertRaises(q.SafetyError):
            self.engine.auto(self.req)

    def test_auto_publishes_same_parent_and_records_unreviewed(self):
        result = self.auto()
        self.assertEqual(result["state"], "published")
        self.assertEqual(result["publicationMode"], "automatic")
        self.assertEqual(result["qualityReview"], "not-reviewed")
        self.assertEqual(self.z.attached["OUTPUTAA"]["meta"]["parentItem"], "PARENTAA")
        self.assertTrue(self.z.attached["OUTPUTAA"]["meta"]["title"].endswith(" · 自动识别待复核"))

    def test_repeated_auto_does_not_repeat_ocr_or_import(self):
        self.auto()
        self.auto()
        self.assertEqual(self.dt.ocr_count, 1)
        self.assertEqual(self.z.imports, 1)

    def test_lost_publish_reply_auto_recovers_without_duplicate(self):
        self.engine.submit(self.req)
        self.z.lose_response = True
        with self.assertRaises(TimeoutError):
            self.auto()
        self.assertEqual(self.auto()["state"], "published")
        self.assertEqual(self.dt.ocr_count, 1)
        self.assertEqual(self.z.imports, 1)

    def test_uncertain_ocr_is_not_retried_by_auto(self):
        self.dt.timeout = True
        with self.assertRaises(TimeoutError):
            self.auto()
        with self.assertRaises(q.SafetyError):
            self.auto()
        self.assertEqual(self.dt.ocr_count, 1)

    def test_historical_review_publishes_directly_without_ocr(self):
        self.engine.submit(self.req)
        self.dt.ocr_count = 0
        self.assertEqual(self.auto()["state"], "published")
        self.assertEqual(self.dt.ocr_count, 0)

    def test_historical_title_is_compatible(self):
        self.engine.submit(self.req)
        self.engine.publish({**self.req, "approved": True})
        self.assertEqual(self.z.attached["OUTPUTAA"]["meta"]["title"].count("自动识别"), 0)
        self.assertEqual(self.auto()["state"], "published")
        self.assertEqual(self.z.imports, 1)


if __name__ == "__main__":
    unittest.main()
