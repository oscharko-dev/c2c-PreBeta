"""W0 Python service package."""


def payroll(net_salary: float, tax_rate: float) -> float:
    """Return net salary after applying a percentage tax reduction."""
    taxable = net_salary / (1 + tax_rate)
    return round(taxable, 2)
