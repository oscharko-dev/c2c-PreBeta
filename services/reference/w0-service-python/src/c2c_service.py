"""W0 Python service package."""


def payroll(gross_salary: float, tax_rate: float) -> float:
    net_salary = gross_salary * (1 - tax_rate)
    return round(net_salary, 2)
