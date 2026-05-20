from . import payroll


def run_reference() -> str:
    net = payroll(100.0, 0.15)
    return f"NET={net:0.2f}"


def main() -> None:
    print(run_reference())


if __name__ == "__main__":
    main()
