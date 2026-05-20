import unittest

from c2c_service import payroll


class PayrollTests(unittest.TestCase):
    def test_payroll_rounding(self):
        self.assertEqual(payroll(100.0, 0.15), 85.0)


if __name__ == "__main__":
    unittest.main()
